'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const core = require('../packages/core/src');
const { handleToolCall } = require('../packages/mcp-server/src/server');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'memhub-sessions-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'repo');
  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  const stores = core.resolveStores({ cwd, homeDir: base, globalDir: path.join(base, 'global') });
  return { base, cwd, stores };
}
const identity = (id, agent = 'pi-desktop') => ({ origin_agent: agent, source_session_id: id });
const user = (id, text) => ({ message_key: id, role: 'user', text });
const assistant = (id, text) => ({ message_key: id, role: 'assistant', text });
const model = { url: 'https://example.com/v1/chat/completions', model: 'test', timeoutMs: 1000 };
const response = summary => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary }) } }] }) });

test('sessions: immediate cross-agent restore, stable source, parent preference and role attribution', async t => {
  const { stores } = await fixture(t);
  const a = await core.captureSession(stores, { ...identity('a'), messages: [user('u1', 'PocketWorld 正在动作细调'), assistant('a1', '建议先调膝盖；尚未确认')] });
  const restored = await core.restoreSessionContext(stores, identity('b', 'claude-code'));
  assert.deepEqual(restored.sources, [a.session_key]);
  assert.match(restored.block, /pi-desktop/);
  assert.match(restored.block, /\[user #1[\s\S]*PocketWorld/);
  assert.match(restored.block, /\[assistant #2[\s\S]*尚未确认/);
  assert.match(restored.block, /pending/);
  const c = await core.captureSession(stores, { ...identity('c'), messages: [user('u2', '另一窗口')] });
  assert.deepEqual((await core.restoreSessionContext(stores, identity('b', 'claude-code'))).sources, [a.session_key]);
  assert.deepEqual((await core.restoreSessionContext(stores, { ...identity('fork'), parent_session_key: a.session_key })).sources, [a.session_key]);
  await core.captureSession(stores, { ...identity('child'), is_subagent: true, messages: [user('child1', '子代理工作')] });
  assert.deepEqual((await core.restoreSessionContext(stores, identity('d'))).sources, [c.session_key]);
  assert.equal((await core.loadAllEntries(stores)).length, 0);
});

test('sessions: duplicate full transcripts, provisional IDs, same-text distinct messages and concurrent capture', async t => {
  const { stores } = await fixture(t);
  const first = await core.captureSession(stores, { ...identity('../unsafe'), messages: [{ role: 'user', content: '继续' }] });
  const input = { ...identity('../unsafe'), messages: [user('real-1', '继续'), assistant('real-2', '收到')] };
  const results = await Promise.all(Array.from({ length: 5 }, () => core.captureSession(stores, input)));
  assert.equal(results.at(-1).last_seq, 2);
  const latest = await core.captureSession(stores, { ...identity('../unsafe'), messages: [...input.messages, user('real-3', '继续')] });
  assert.equal(latest.last_seq, 3);
  const record = await core.loadSession(stores, { session_key: first.session_key });
  assert.deepEqual(record.messages.map(m => m.seq), [1, 2, 3]);
  assert.equal(record.messages[0].message_key, 'real-1');
  assert.match(first.session_key, /^[a-f0-9]{64}$/);
  const parallel = await Promise.all(['x', 'y'].map(id => core.captureSession(stores, { ...identity(id), messages: [user(id, id)] })));
  const index = JSON.parse(await fs.readFile(path.join(stores.globalDir, 'state/session-locations.json'), 'utf8'));
  assert.ok(parallel.every(r => index[r.session_key]));
  assert.doesNotMatch(JSON.stringify(index), /real-1|继续|收到/);
});

test('sessions: workspace isolation, global nonproject directory binding and explicit discovery', async t => {
  const { base, stores } = await fixture(t);
  const a = await core.captureSession(stores, { ...identity('a'), messages: [user('a1', 'A 中聊 B')] });
  const cwdB = path.join(base, 'other');
  await fs.mkdir(path.join(cwdB, '.git'), { recursive: true });
  const b = core.resolveStores({ cwd: cwdB, homeDir: base, globalDir: stores.globalDir });
  assert.equal((await core.restoreSessionContext(b, identity('b'))).status, 'empty');
  assert.equal((await core.listSessions(b)).some(r => r.session_key === a.session_key), false);
  assert.equal((await core.listSessions(b, { cross_workspace: true })).some(r => r.session_key === a.session_key), true);
  const loaded = await core.loadSession(b, { session_key: a.session_key, workspace_root: stores.cwd, from_seq: 1, to_seq: 1 });
  assert.equal(loaded.messages[0].text, 'A 中聊 B');
  for (const dir of ['daily1', 'daily2']) await fs.mkdir(path.join(base, dir));
  const nonproject = dir => core.resolveStores({ cwd: path.join(base, dir), homeDir: base, globalDir: stores.globalDir });
  await core.captureSession(nonproject('daily1'), { ...identity('daily'), messages: [user('daily1', '日常聊天')] });
  assert.equal((await core.listSessions(nonproject('daily2'))).length, 0);
});

test('sessions: redaction, injection removal, hidden reasoning exclusion, snapshot recovery and long originals', async t => {
  const { stores } = await fixture(t);
  const secret = `sk-${'a'.repeat(30)}`;
  const input = { ...identity('a'), messages: [
    user('u1', `问题 ${secret}\n<memory-boot>递归旧记忆</memory-boot>\n<memory-session>旧对话</memory-session>`),
    { role: 'assistant', id: 'a1', content: [{ type: 'thinking', thinking: '隐藏推理' }, { type: 'text', text: '公开建议' }] },
    user('u2', `长原文${'字'.repeat(300000)}`),
  ] };
  const saved = await core.captureSession(stores, input);
  await fs.writeFile(saved.path, 'stale snapshot');
  const restored = await core.restoreSessionContext(stores, { ...identity('b'), max_chars: 1000 });
  assert.equal(restored.truncated, true);
  assert.match(restored.block, /展示已裁剪/);
  const record = await core.loadSession(stores, { session_key: saved.session_key });
  assert.match(record.messages[0].text, /<REDACTED>/);
  assert.doesNotMatch(JSON.stringify(record), /递归旧记忆|旧对话|隐藏推理/);
  assert.equal(record.messages[2].text.length, 300003);
  assert.match(await fs.readFile(saved.path, 'utf8'), /长原文/);
  assert.doesNotMatch(await fs.readFile(path.join(path.dirname(saved.path), 'turns.jsonl'), 'utf8'), new RegExp(secret));
  await assert.rejects(core.loadSession(stores, { session_key: '../escape' }), /Invalid session_key/);
});

test('sessions: summary failure/disabled degrade to originals, incremental coverage never includes unseen messages', async t => {
  const { stores } = await fixture(t);
  const saved = await core.captureSession(stores, { ...identity('a'), messages: [user('u1', '用户事实'), assistant('a1', '助手建议')] });
  assert.equal((await core.summarizeSession(stores, { session_key: saved.session_key, config: null })).status, 'disabled');
  const failed = await core.summarizeSession(stores, { session_key: saved.session_key, config: model, fetchImpl: async () => ({ ok: false }) });
  assert.equal(failed.status, 'failed');
  assert.equal((await core.loadSession(stores, { session_key: saved.session_key })).messages.length, 2);
  let finish;
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const slow = core.summarizeSession(stores, { session_key: saved.session_key, config: model, fetchImpl: async () => { requestStarted(); return new Promise(resolve => { finish = resolve; }); } });
  await started;
  await core.captureSession(stores, { ...identity('a'), messages: [user('u3', '模型等待期间的新消息')] });
  const immediate = await core.restoreSessionContext(stores, identity('during-summary'));
  assert.match(immediate.block, /模型等待期间的新消息/);
  finish(response('用户事实；助手建议尚未确认。未完成：等待用户选择。'));
  assert.equal((await slow).summary_through_seq, 2);
  const record = await core.loadSession(stores, { session_key: saved.session_key });
  assert.equal(record.meta.last_seq, 3);
  assert.equal(record.meta.summary_status, 'pending');
  assert.equal((await core.listInboxBatches(stores)).length, 0);
  const status = await core.sessionDiagnostics(stores);
  assert.equal(status.sessions.find(s => s.session_key === saved.session_key).uncovered_messages, 1);
  assert.doesNotMatch(JSON.stringify(status), /用户事实|助手建议/);
});

test('sessions: old summary late return cannot replace newer coverage or recent snapshot', async t => {
  const { stores } = await fixture(t);
  const saved = await core.captureSession(stores, { ...identity('a'), messages: [user('u1', '第一条')] });
  let finish, notify;
  const started = new Promise(resolve => { notify = resolve; });
  const slow = core.summarizeSession(stores, { session_key: saved.session_key, config: model, fetchImpl: async () => { notify(); return new Promise(resolve => { finish = resolve; }); } });
  await started;
  await core.captureSession(stores, { ...identity('a'), messages: [user('u2', '第二条')] });
  const fast = await core.summarizeSession(stores, { session_key: saved.session_key, config: model, fetchImpl: async () => response('新摘要') });
  assert.equal(fast.summary_through_seq, 2);
  finish(response('旧摘要'));
  assert.equal((await slow).status, 'stale');
  const record = await core.loadSession(stores, { session_key: saved.session_key });
  assert.equal(record.summary, '新摘要');
  assert.match(await fs.readFile(saved.path, 'utf8'), /第二条/);
});

test('sessions: location failure leaves local records usable, ignore rules survive, symlinks rejected', async t => {
  const { stores, base } = await fixture(t);
  await fs.mkdir(path.join(stores.globalDir, 'state'), { recursive: true });
  await fs.writeFile(path.join(stores.globalDir, 'state/session-locations.json'), 'invalid');
  await fs.mkdir(path.join(stores.projectDir, 'sessions'), { recursive: true });
  const ignore = path.join(stores.projectDir, 'sessions/.gitignore');
  await fs.writeFile(ignore, '# user rules\nprivate-*\n');
  const saved = await core.captureSession(stores, { ...identity('a'), messages: [user('u', '原话')] });
  assert.equal(saved.index_status, 'failed');
  assert.equal((await core.restoreSessionContext(stores, identity('b'))).status, 'restored');
  assert.match(await fs.readFile(ignore, 'utf8'), /^# user rules\nprivate-\*\n\*/);
  const malicious = core.sessionIdentity(stores, identity('symlink'));
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(stores.projectDir, 'sessions', malicious.session_key));
  await assert.rejects(core.captureSession(stores, { ...identity('symlink'), messages: [user('x', 'x')] }), /Symlink rejected/);
});

test('sessions: local independent switches, summary config and MCP/CLI entry points', async t => {
  const { stores, cwd } = await fixture(t);
  await fs.mkdir(stores.globalDir, { recursive: true });
  await fs.writeFile(path.join(stores.globalDir, 'config.json'), JSON.stringify({ sessions: { enabled: false }, summary: { enabled: false }, review: { url: 'https://example.com/v1', model: 'review' } }));
  assert.equal((await core.captureSession(stores, identity('disabled'))).status, 'disabled');
  assert.equal(core.summaryConfig(stores, {}), null);
  await fs.writeFile(path.join(stores.globalDir, 'config.json'), JSON.stringify({ sessions: { enabled: true }, summary: { ...model } }));
  assert.equal(core.summaryConfig(stores, {}).model, 'test');
  const defaults = { cwd, globalDir: stores.globalDir, homeDir: stores.homeDir };
  const result = await handleToolCall('memory_session_capture', { ...identity('mcp'), messages: [user('m1', 'MCP 原话')] }, defaults);
  const key = JSON.parse(result.content[0].text).session_key;
  const loaded = await handleToolCall('memory_session_load', { session_key: key }, defaults);
  assert.match(loaded.content[0].text, /MCP 原话/);
  const boot = await handleToolCall('memory_boot', identity('next', 'codex'), defaults);
  assert.match(boot.content[0].text, /memory-session/);
  const cli = spawnSync(process.execPath, ['packages/cli/bin/memhub.js', 'session', 'load', '--cwd', cwd, '--key', key], { encoding: 'utf8', env: { ...process.env, MEMHUB_GLOBAL_DIR: stores.globalDir } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).messages[0].text, 'MCP 原话');
});

test('PI: request-time user capture, agent-end save without review model and immediate new-session recovery', async t => {
  const { stores, cwd } = await fixture(t);
  const previous = process.env.MEMHUB_GLOBAL_DIR;
  process.env.MEMHUB_GLOBAL_DIR = stores.globalDir;
  t.after(() => { if (previous === undefined) delete process.env.MEMHUB_GLOBAL_DIR; else process.env.MEMHUB_GLOBAL_DIR = previous; });
  const extension = require('../adapters/pi-desktop/extension')._internals;
  const ctx = id => ({ cwd, sessionId: id });
  const prompt = { role: 'user', content: '跨项目进度仍属于工作区的对话' };
  await extension.onProviderRequest({ payload: { messages: [prompt] } }, ctx('a'));
  let list = await core.listSessions(stores);
  assert.equal(list[0].last_seq, 1);
  await extension.onAgentEnd({ messages: [{ ...prompt, timestamp: 1700000000000 }, { role: 'assistant', timestamp: 1700000001000, content: [{ type: 'text', text: '尚未确认的建议' }] }] }, ctx('a'));
  const next = await extension.onProviderRequest({ payload: { messages: [{ role: 'user', content: '继续' }] } }, ctx('b'));
  assert.match(next.messages[0].content, /memory-session/);
  assert.match(next.messages[0].content, /跨项目进度仍属于工作区的对话/);
  assert.match(next.messages[0].content, /尚未确认的建议/);
  list = await core.listSessions(stores);
  assert.equal(list.find(s => s.source_session_id === 'a').last_seq, 2);
  await extension.onProviderRequest({ payload: next }, ctx('b'));
  const b = list.find(s => s.source_session_id === 'b');
  const savedB = await core.loadSession(stores, { session_key: b.session_key });
  assert.equal(savedB.messages[0].text, '继续');
  assert.equal((await core.loadAllEntries(stores)).length, 0);
});

test('sessions: tool records never become user quotes and binary images are only references', async t => {
  const { stores } = await fixture(t);
  const result = await core.captureSession(stores, { ...identity('tools'), messages: [
    { role: 'assistant', id: 'call', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', id: 'result', content: [{ type: 'tool_result', content: '测试尚未完成' }] },
    { role: 'user', id: 'picture', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,secretbinary' } }] },
  ] });
  const record = await core.loadSession(stores, { session_key: result.session_key });
  assert.deepEqual(record.messages.map(m => [m.role, m.type]), [['tool', 'tool_call'], ['tool', 'tool_result'], ['user', 'message']]);
  assert.ok(record.messages.every(m => m.turn_id));
  assert.doesNotMatch(JSON.stringify(record), /secretbinary/);
  assert.match(record.messages[2].text, /未保存二进制/);
});

test('sessions: invalid summary and budget overflow do not advance coverage; index can be rebuilt', async t => {
  const { stores } = await fixture(t);
  const saved = await core.captureSession(stores, { ...identity('budget'), messages: [user('one', '第一条'), user('two', '第二条长消息')] });
  const invalid = await core.summarizeSession(stores, { session_key: saved.session_key, config: model, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'invalid JSON' } }] }) }) });
  assert.equal(invalid.reason, 'invalid-response');
  assert.equal(invalid.summary_through_seq, 0);
  const partial = await core.summarizeSession(stores, { session_key: saved.session_key, config: model, max_chars: 4, fetchImpl: async () => response('第一条摘要') });
  assert.equal(partial.summary_through_seq, 1);
  assert.equal(partial.status, 'pending');
  const blocked = await core.summarizeSession(stores, { session_key: saved.session_key, config: model, max_chars: 4 });
  assert.equal(blocked.reason, 'message-exceeds-summary-budget');
  assert.equal(blocked.summary_through_seq, 1);
  await fs.writeFile(path.join(stores.globalDir, 'state/session-locations.json'), 'broken index');
  assert.equal((await core.rebuildSessionLocations(stores)).locations, 1);
  assert.equal((await core.sessionDiagnostics(stores)).index, 'readable');
});

test('sessions: independent CLI processes preserve all concurrent messages and index locations', async t => {
  const { stores, cwd } = await fixture(t);
  const { spawn } = require('node:child_process');
  const outputs = await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['packages/cli/bin/memhub.js', 'session', 'capture', '--cwd', cwd], { env: { ...process.env, MEMHUB_GLOBAL_DIR: stores.globalDir } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify({ ...identity('processes'), messages: [user(`process-${i}`, `消息 ${i}`)] }));
  })));
  const record = await core.loadSession(stores, { session_key: outputs[0].session_key });
  assert.equal(record.meta.last_seq, 4);
  assert.equal(new Set(record.messages.map(m => m.message_key)).size, 4);
});

test('PI session tools: invocation context without cwd falls back to workspace and reports missing workspace', async t => {
  const { stores, cwd, base } = await fixture(t);
  const previousPi = global.pi;
  const previousGlobal = process.env.MEMHUB_GLOBAL_DIR;
  process.env.MEMHUB_GLOBAL_DIR = stores.globalDir;
  t.after(() => {
    global.pi = previousPi;
    if (previousGlobal === undefined) delete process.env.MEMHUB_GLOBAL_DIR;
    else process.env.MEMHUB_GLOBAL_DIR = previousGlobal;
  });
  const { tools } = require('../adapters/pi-desktop/main')._internals;
  global.pi = { workspace: { get: async () => ({ path: cwd }) } };
  const result = await tools.session_status({}, { sessionId: 'tool-context' });
  assert.equal(result.workspace_root, cwd);
  assert.deepEqual(await tools.session_list({}, { sessionId: 'tool-context' }), []);
  const nonproject = path.join(base, 'daily');
  await fs.mkdir(nonproject);
  assert.equal((await tools.session_status({ cwd: nonproject }, {})).workspace_root, nonproject);
  global.pi = { workspace: { get: async () => ({}) } };
  await assert.rejects(tools.session_status({}, { sessionId: 'tool-context' }), /workspace is unavailable; pass cwd/);
  await assert.rejects(tools.session_status({ cwd: 'relative' }, {}), /cwd must be an absolute path/);
});
