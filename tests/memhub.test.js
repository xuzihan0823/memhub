'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const core = require('../packages/core/src');
const { startDaemon } = require('../packages/daemon/src/server');
const { processRpcMessage } = require('../packages/mcp-server/src/server');
const { detectAgents, installForAgent, uninstallFromHome } = require('../packages/cli/src/setup');
const { runHook } = require('../packages/cli/src/hook');

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return core.todayStr(d);
}

async function writeEntry(rootDir, relPath, meta, body = '正文') {
  await core.atomicWriteText(rootDir, relPath, core.serializeEntry(meta, body));
}

async function makeTempWorkspace() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'memhub-test-'));
  const homeDir = path.join(base, 'home');
  const globalDir = path.join(homeDir, '.memory');
  const repoDir = path.join(base, 'repo');
  await fsp.mkdir(path.join(repoDir, '.git'), { recursive: true });
  return { base, homeDir, globalDir, repoDir };
}

test('core: dual-scope scaffold, search, dedup/supersede, and forget', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    await core.scaffoldGlobalStore(stores.globalDir);
    await core.scaffoldProjectStore(stores.projectDir);

    // 1. Propose global + project memories -> auto-committed autonomously by default
    const prop1 = await core.proposeMemory(stores, {
      agent: 'claude-code',
      items: [
        {
          title: '生产镜像必须指定 linux/amd64 架构',
          content: 'Mac 本地是 arm64，构建 Linux 服务端镜像必须使用 --platform linux/amd64。',
          keywords: ['docker', 'amd64', '部署'],
          scope: 'global',
          type: 'skill',
          salience: 1,
        },
        {
          title: '坐下动作优化交接单',
          content: '已完成骨架绑定，下一步需要微调膝盖 IK 权重。',
          keywords: ['坐下动作', 'IK', '交接'],
          scope: 'handoff',
          type: 'handoff',
          ttl_days: 7,
        },
      ],
    });
    assert.equal(prop1.status, 'committed');
    assert.equal(prop1.committed.length, 2);
    // 2. Search across both global and project scopes (Chinese bigrams + English)
    const entries = await core.loadAllEntries(stores);
    const hits = core.searchEntries(entries, 'amd64 部署 镜像', { limit: 5 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].entry.scope, 'global');

    const handoffHits = core.searchEntries(entries, '坐下动作 IK', { limit: 5 });
    assert.ok(handoffHits.length >= 1);
    assert.equal(handoffHits[0].entry.scope, 'handoff');

    // 3. Prompt-injection safe block rendering
    const block = core.renderMemoryContext(hits);
    assert.match(block, /<memory-context/);
    assert.match(block, /生产镜像必须指定 linux\/amd64 架构/);

    // 4. Propose same title -> auto-supersedes old entry autonomously
    const oldId = prop1.committed[0].id;
    const prop2 = await core.proposeMemory(stores, {
      agent: 'codex',
      items: [
        {
          title: '生产镜像必须指定 linux/amd64 架构',
          content: '新版构建规范：统一使用 buildx --platform linux/amd64 --push 推送。',
          keywords: ['docker', 'buildx', 'amd64'],
          scope: 'global',
          type: 'skill',
          salience: 1,
        },
      ],
    });
    assert.equal(prop2.status, 'committed');
    assert.equal(prop2.committed[0].action, 'supersede');
    const newId = prop2.committed[0].id;
    const refreshedOld = await core.loadEntryById(stores, oldId, { touchAccess: false });
    assert.equal(refreshedOld.status, 'deprecated');
    assert.equal(refreshedOld.supersededBy, newId);

    // 5. Physical delete requires confirm: true; archive works autonomously
    await assert.rejects(
      () => core.forgetEntry(stores, { id: newId, mode: 'delete' }),
      /requires explicit confirm: true/
    );
    const arch = await core.forgetEntry(stores, { id: newId, mode: 'archive', reason: 'test archive' });
    assert.equal(arch.mode, 'archive');
    const afterEntries = await core.loadAllEntries(stores);
    assert.equal(afterEntries.find(e => e.id === newId), undefined);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('daemon + web-ui + mcp-server: end-to-end HTTP and JSON-RPC 2.0', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  const { server, url } = await startDaemon({ port: 0, homeDir, globalDir, defaultCwd: repoDir });
  try {
    // 1. Web UI HTML served
    const htmlRes = await fetch(`${url}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /MemHub · 本地跨 Agent 记忆控制台/);

    // 2. Quick soul update via HTTP
    const soulRes = await fetch(`${url}/api/soul`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'Jarvis', userAddress: '老板', persona: '简洁犀利', boundaries: '禁止直推 main' }),
    });
    assert.equal(soulRes.status, 200);

    // 3. Boot via MCP JSON-RPC
    const initRpc = await processRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { homeDir, globalDir, cwd: repoDir });
    assert.equal(initRpc.result.serverInfo.name, 'memhub');

    const listRpc = await processRpcMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { homeDir, globalDir, cwd: repoDir });
    assert.deepEqual(listRpc.result.tools.filter(tool => tool.name.startsWith('memory_session_')).map(tool => tool.name).sort(), ['memory_session_capture', 'memory_session_list', 'memory_session_load', 'memory_session_restore', 'memory_session_status']);

    const bootRpc = await processRpcMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory_boot', arguments: { cwd: repoDir } },
    }, { homeDir, globalDir, cwd: repoDir });
    assert.match(bootRpc.result.content[0].text, /Jarvis/);

    // 4. Auto-approved handoff via HTTP propose
    const propRes = await fetch(`${url}/api/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: repoDir,
        agent: 'pi-desktop',
        autoApproveLowRisk: true,
        items: [{ title: 'MCP 握手测试进度', content: '已完成 initialize 与 tools/list 验证', scope: 'handoff', keywords: ['MCP', '测试'] }],
      }),
    });
    const propJson = await propRes.json();
    assert.equal(propJson.status, 'committed');

    // 5. Search via MCP
    const searchRpc = await processRpcMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'MCP 握手', cwd: repoDir } },
    }, { homeDir, globalDir, cwd: repoDir });
    const parsedHits = JSON.parse(searchRpc.result.content[0].text).hits;
    assert.ok(parsedHits.length >= 1);

    // 6. Graph endpoint
    const graphRes = await fetch(`${url}/api/graph?cwd=${encodeURIComponent(repoDir)}`);
    const graphJson = await graphRes.json();
    assert.ok(Array.isArray(graphJson.nodes));
  } finally {
    server.close();
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('cli setup: sandboxed agent detection, backup, install, and uninstall', async () => {
  const { base, homeDir } = await makeTempWorkspace();
  try {
    await fsp.mkdir(path.join(homeDir, '.claude'), { recursive: true });
    await fsp.writeFile(path.join(homeDir, '.claude', 'settings.json'), '{"model":"sonnet"}\n');
    await fsp.mkdir(path.join(homeDir, '.codex'), { recursive: true });
    await fsp.writeFile(path.join(homeDir, '.codex', 'config.toml'), 'model = "gpt-5"\n');

    const detected = detectAgents(homeDir);
    assert.equal(detected.find(a => a.id === 'claude').installed, true);
    assert.equal(detected.find(a => a.id === 'codex').installed, true);

    await installForAgent('claude', { homeDir });
    await installForAgent('codex', { homeDir });

    const claudeCfg = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(claudeCfg.model, 'sonnet');
    assert.ok(Array.isArray(claudeCfg.hooks.UserPromptSubmit));

    const codexToml = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
    assert.match(codexToml, /\[mcp_servers\.memhub\]/);

    await uninstallFromHome(homeDir);
    const restoredClaude = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(restoredClaude.hooks, undefined);
    const restoredCodex = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
    assert.equal(restoredCodex, 'model = "gpt-5"\n');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('core: distinguishes project folders from non-project directories and stores non-project handoffs globally', async () => {
  const { base, homeDir, globalDir } = await makeTempWorkspace();
  try {
    const plainDir = path.join(homeDir, 'Desktop', 'plain-dir');
    const desktopDir = path.join(homeDir, 'Desktop');
    await fsp.mkdir(plainDir, { recursive: true });

    // Non-project folder (no .git / package.json / .memory) -> projectDir is null
    const nonProj = core.resolveStores({ homeDir, globalDir, cwd: plainDir });
    assert.equal(nonProj.projectDir, null);

    const atDesktop = core.resolveStores({ homeDir, globalDir, cwd: desktopDir });
    assert.equal(atDesktop.projectDir, null);

    // Propose a handoff outside any project -> saved under ~/.memory/handoffs and loaded in bootContext
    const prop = await core.proposeMemory(nonProj, {
      agent: 'claude-code',
      autoApproveLowRisk: true,
      items: [{
        title: '非项目态规划交接：网关拆分方案',
        content: '下个会话继续按三步拆分网关认证模块。',
        scope: 'handoff',
        type: 'handoff',
        keywords: ['网关', '规划'],
      }],
    });
    assert.equal(prop.status, 'committed');
    assert.equal(prop.committed[0].scope, 'handoff');
    assert.equal(prop.committed[0].rootDir, globalDir);

    const boot = await core.bootContext(nonProj);
    assert.ok(boot.activeHandoffs.some(line => line.includes('非项目态规划交接：网关拆分方案')));

    // Explicit project folder (has package.json) -> recognized as project
    const nodeProj = path.join(homeDir, 'Desktop', 'my-app');
    await fsp.mkdir(nodeProj, { recursive: true });
    await fsp.writeFile(path.join(nodeProj, 'package.json'), '{"name":"my-app"}\n');
    const projStores = core.resolveStores({ homeDir, globalDir, cwd: nodeProj });
    assert.equal(projStores.projectDir, path.join(nodeProj, '.memory'));
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('core: preserves DSH custom SOUL.md and DSH section index.md', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    await core.scaffoldGlobalStore(globalDir);
    const customSoul = '# SOUL — 自定义人格\n\n## 身份\n- 名字：测试人格\n';
    await core.atomicWriteText(globalDir, 'SOUL.md', customSoul);
    await assert.rejects(
      () => core.upsertSoul(globalDir, { agentName: 'Other' }),
      /已保护不覆盖/
    );
    assert.equal(fs.readFileSync(path.join(globalDir, 'SOUL.md'), 'utf8'), customSoul);

    const dshIndex = [
      '# Memory Index',
      '',
      '## user（关于用户）',
      '',
      '_（暂无）_',
      '',
      '## skills（程序性记忆）',
      '',
      '_（暂无）_',
      '',
    ].join('\n');
    await core.atomicWriteText(globalDir, 'index.md', dshIndex);
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    const prop = await core.proposeMemory(stores, {
      agent: 'test',
      requireReview: true,
      items: [{ title: 'DSH 兼容测试', content: '保留分节目录', scope: 'global', type: 'skill' }],
    });
    assert.equal(prop.status, 'pending_review');
    await core.commitBatch(stores, prop.batchId);
    const nextIdx = fs.readFileSync(path.join(globalDir, 'index.md'), 'utf8');
    assert.match(nextIdx, /## user（关于用户）/);
    assert.match(nextIdx, /## skills（程序性记忆）/);
    assert.match(nextIdx, /DSH 兼容测试/);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('adapter: pi-desktop extension retrieves memories in background without daemon', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  const prevGlobal = process.env.MEMHUB_GLOBAL_DIR;
  process.env.MEMHUB_GLOBAL_DIR = globalDir;
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    await core.proposeMemory(stores, {
      agent: 'pi-desktop',
      items: [{
        title: '后台自动检索测试条目',
        content: '无需常驻后台进程即可在 before_provider_request 检索出这条记忆。',
        keywords: ['后台检索', 'before_provider_request', '无守护进程'],
        scope: 'project',
        type: 'skill',
        salience: 1,
      }],
    });

    const extPath = path.resolve(__dirname, '../adapters/pi-desktop/extension.js');
    delete require.cache[require.resolve(extPath)];
    const register = require(extPath);
    const handlers = {};
    register({ on: (evt, fn) => { handlers[evt] = fn; } });

    const payload1 = {
      messages: [{ role: 'user', content: '请帮我确认 后台检索 和 无守护进程 的逻辑' }],
    };
    const next1 = await handlers.before_provider_request({ payload: payload1 }, { cwd: repoDir });
    assert.ok(next1);
    assert.match(next1.messages[0].content, /<memory-context/);
    assert.match(next1.messages[0].content, /后台自动检索测试条目/);

    // Second turn in same session should NOT duplicate the same entry
    const payload2 = {
      messages: [
        { role: 'user', content: '请帮我确认 后台检索 和 无守护进程 的逻辑' },
        { role: 'assistant', content: '好的' },
        { role: 'user', content: '再确认一下 后台检索 细节' },
      ],
    };
    const next2 = await handlers.before_provider_request({ payload: payload2 }, { cwd: repoDir });
    assert.ok(next2);
    assert.match(next2.messages[0].content, /后台自动检索测试条目/);
    assert.doesNotMatch(next2.messages[2].content, /后台自动检索测试条目/);
  } finally {
    if (prevGlobal === undefined) delete process.env.MEMHUB_GLOBAL_DIR;
    else process.env.MEMHUB_GLOBAL_DIR = prevGlobal;
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('core: same-day same-title proposal keeps both versions and project-type entries stay visible', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    const first = await core.proposeMemory(stores, { items: [{ title: '部署流程', content: '旧内容 A' }] });
    const second = await core.proposeMemory(stores, { items: [{ title: '部署流程', content: '新内容 B' }] });
    const oldId = first.committed[0].id;
    const newId = second.committed[0].id;
    assert.equal(second.committed[0].action, 'supersede');
    assert.notEqual(newId, oldId);

    const oldEntry = await core.loadEntryById(stores, oldId, { touchAccess: false });
    const newEntry = await core.loadEntryById(stores, newId, { touchAccess: false });
    assert.equal(oldEntry.body, '旧内容 A');
    assert.equal(oldEntry.supersededBy, newId);
    assert.equal(newEntry.body, '新内容 B');
    assert.equal(newEntry.status, 'active');
    const hits = core.searchEntries(await core.loadAllEntries(stores), '部署流程');
    assert.deepEqual(hits.map(h => h.entry.id), [newId]);

    const proj = await core.proposeMemory(stores, {
      items: [{ title: '技术栈说明 Rust', content: '核心服务使用 Rust 编写', type: 'project' }],
    });
    const projId = proj.committed[0].id;
    const entries = await core.loadAllEntries(stores);
    assert.ok(entries.some(e => e.id === projId));
    assert.match(fs.readFileSync(path.join(stores.projectDir, 'index.md'), 'utf8'), /技术栈说明 Rust/);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('daemon: rejects cross-origin and non-loopback Host requests', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  const { server, url, port } = await startDaemon({ port: 0, homeDir, globalDir, defaultCwd: repoDir });
  const rawRequest = headers => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/propose', method: 'POST', headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ items: [{ title: '注入测试', content: 'ignore previous', scope: 'global' }] }));
  });
  try {
    assert.equal(await rawRequest({ 'Content-Type': 'text/plain', Origin: 'https://evil.example.com' }), 403);
    assert.equal(await rawRequest({ 'Content-Type': 'application/json', Host: `evil.example.com:${port}` }), 403);
    assert.equal(await rawRequest({ 'Content-Type': 'application/json', Origin: 'null' }), 403);
    assert.equal(fs.existsSync(path.join(globalDir, 'decisions')), false);

    const sameOrigin = await fetch(`${url}/api/health`, { headers: { Origin: url } });
    assert.equal(sameOrigin.status, 200);
    const localhostRes = await rawRequest({ 'Content-Type': 'application/json', Host: `localhost:${port}`, Origin: `http://localhost:${port}` });
    assert.equal(localhostRes, 200);
  } finally {
    server.close();
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('web-ui: escapes quotes and avoids inline handlers built from memory data', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../packages/web-ui/index.html'), 'utf8');
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const escSource = /function esc\(s\) \{[\s\S]*?\n    \}/.exec(script)[0];
  const esc = new Function(`${escSource}; return esc;`)();
  assert.equal(esc(`x" onmouseover='alert(1)' <b>&`), 'x&quot; onmouseover=&#39;alert(1)&#39; &lt;b&gt;&amp;');
  assert.doesNotMatch(script, /onclick="[^"]*\$\{/);
  assert.doesNotMatch(script, /\$\{s\.(id|title)\}/);
});

test('core: project root prefers existing .memory, then git root, and ignores containers', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    const pkgDir = path.join(repoDir, 'packages', 'web');
    await fsp.mkdir(pkgDir, { recursive: true });
    await fsp.writeFile(path.join(pkgDir, 'package.json'), '{}');
    assert.equal(core.resolveStores({ homeDir, globalDir, cwd: pkgDir }).projectRoot, repoDir);

    await fsp.mkdir(path.join(pkgDir, '.memory'));
    assert.equal(core.resolveStores({ homeDir, globalDir, cwd: path.join(pkgDir) }).projectRoot, pkgDir);

    const loose = path.join(homeDir, 'Desktop', 'notes', 'sub');
    await fsp.mkdir(loose, { recursive: true });
    await fsp.writeFile(path.join(homeDir, 'Desktop', 'notes', 'Makefile'), 'all:\n');
    assert.equal(core.resolveStores({ homeDir, globalDir, cwd: loose }).projectDir, null);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('core: scope rules reject project memory outside projects and keep handoffs local', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    const outside = path.join(homeDir, 'Desktop', 'plan-a');
    const otherOutside = path.join(homeDir, 'Desktop', 'plan-b');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.mkdir(otherOutside, { recursive: true });
    const outStores = core.resolveStores({ homeDir, globalDir, cwd: outside });

    await assert.rejects(() => core.proposeMemory(outStores, { items: [{ title: '项目约定', content: 'x', scope: 'project' }] }), /不在项目内/);
    await assert.rejects(() => core.proposeMemory(outStores, { items: [{ title: '未指定', content: 'x' }] }), /未指定 scope/);

    const res = await core.proposeMemory(outStores, { items: [{ title: '网关拆分规划', content: '- [ ] 拆认证', scope: 'handoff', task: 'gateway-split' }] });
    assert.equal(res.committed[0].rootDir, globalDir);
    const hoff = await core.loadEntryById(outStores, res.committed[0].id, { touchAccess: false });
    assert.equal(hoff.cwd, outside);

    const otherStores = core.resolveStores({ homeDir, globalDir, cwd: otherOutside });
    const projStores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    assert.equal((await core.loadAllEntries(otherStores)).some(e => e.id === hoff.id), false);
    assert.equal((await core.loadAllEntries(projStores)).some(e => e.id === hoff.id), false);
    assert.equal((await core.bootContext(outStores)).activeHandoffs.length, 1);

    const projRes = await core.proposeMemory(projStores, { items: [{ title: '项目进度', content: '- [ ] a', scope: 'handoff' }] });
    assert.equal(projRes.committed[0].rootDir, projStores.projectDir);
    assert.ok(fs.existsSync(path.join(projStores.projectDir, 'handoffs', '.gitignore')));
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('core: handoffs upsert by task, close into archive, and expire by TTL', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    const first = await core.proposeMemory(stores, { items: [{ title: '修复 MemHub 检索', content: '- [ ] A\n- [ ] B', scope: 'handoff', task: 'memhub-fix' }] });
    const second = await core.proposeMemory(stores, { items: [{ title: '修复 MemHub 检索', content: '- [x] A（测试通过）\n- [ ] B', scope: 'handoff', task: 'memhub-fix', status: 'blocked' }] });
    assert.equal(second.committed[0].action, 'update');
    assert.equal(second.committed[0].id, first.committed[0].id);
    let handoffs = (await core.loadAllEntries(stores)).filter(e => e.scope === 'handoff');
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].status, 'blocked');
    assert.match(handoffs[0].body, /\[x\] A/);

    const done = await core.proposeMemory(stores, { items: [{ title: '修复 MemHub 检索', content: '- [x] A\n- [x] B', scope: 'handoff', task: 'memhub-fix', status: 'done' }] });
    assert.equal(done.committed[0].action, 'close');
    assert.match(done.committed[0].relPath, /^archive\//);
    handoffs = (await core.loadAllEntries(stores)).filter(e => e.scope === 'handoff');
    assert.equal(handoffs.length, 0);

    await core.scaffoldProjectStore(stores.projectDir);
    await writeEntry(stores.projectDir, 'handoffs/hoff-old.md', {
      id: 'hoff-old', scope: 'handoff', type: 'handoff', title: '过期交接', summary: '旧', status: 'active',
      task: 'old', created_at: isoDaysAgo(30), updated_at: isoDaysAgo(20), ttl_days: 14,
    });
    const entries = await core.loadAllEntries(stores);
    const old = entries.find(e => e.id === 'hoff-old');
    assert.equal(core.isActiveEntry(old), false);
    assert.equal(core.searchEntries(entries, '过期交接').length, 0);
    const boot = await core.bootContext(stores);
    assert.deepEqual(boot.archivedHandoffs, ['hoff-old']);
    assert.ok(fs.existsSync(path.join(stores.projectDir, 'archive', 'hoff-old.md')));
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('retrieval: boot catalog, triggers, short follow-ups, paths, and optional rerank', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    await core.proposeMemory(stores, {
      items: [
        { title: '生产镜像必须指定 linux/amd64 架构', summary: 'Mac 是 arm64', content: 'docker build --platform linux/amd64', scope: 'global', type: 'skill', salience: 1, triggers: ['上线', '部署', '服务器', '打包'] },
        { title: '守护进程只接受本机 Host', content: '跨站请求返回 403', scope: 'project', type: 'decision', paths: ['packages/daemon/**'] },
      ],
    });

    const boot = await core.bootContext(stores);
    const block = core.renderBootBlock(boot);
    assert.match(block, /<memory-catalog/);
    assert.match(block, /生产镜像必须指定 linux\/amd64 架构 — Mac 是 arm64/);
    assert.match(block, /守护进程只接受本机 Host/);

    const deploy = await core.retrieveContext(stores, { query: '帮我把服务打包上线到服务器', rerank: null });
    assert.match(deploy.block || '', /linux\/amd64/);

    const followUp = await core.retrieveContext(stores, { query: '继续', previousContext: '下一步要处理 amd64 镜像构建', rerank: null });
    assert.match(followUp.block || '', /linux\/amd64/);

    const byPath = await core.retrieveContext(stores, { paths: ['packages/daemon/src/server.js'], rerank: null });
    assert.match(byPath.block || '', /守护进程只接受本机 Host/);

    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const candidates = JSON.parse(init.body).messages[1].content;
      const id = /^(dec-[^ |]+)/m.exec(candidates.split('<candidates>\n')[1])[1];
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ ids: [id, 'not-a-real-id'] }) } }] }) };
    };
    const rerank = core.rerankConfig({ MEMHUB_RERANK_URL: 'https://llm.example.com/v1', MEMHUB_RERANK_MODEL: 'tiny' });
    const reranked = await core.retrieveContext(stores, { query: '检查一下这个请求', rerank, fetchImpl: fakeFetch });
    assert.equal(reranked.mode, 'rerank');
    assert.equal(calls[0].url, 'https://llm.example.com/v1/chat/completions');
    assert.match(reranked.block, /守护进程只接受本机 Host/);
    assert.doesNotMatch(reranked.block, /not-a-real-id/);

    const failing = await core.retrieveContext(stores, { query: 'amd64 镜像构建', rerank, fetchImpl: async () => { throw new Error('down'); } });
    assert.equal(failing.mode, 'keyword-fallback');
    assert.match(failing.block || '', /linux\/amd64/);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('catalog: short refs, per-type overflow hint, type browsing, and ref resolution', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    for (let i = 0; i < 12; i++) {
      await core.proposeMemory(stores, { items: [{ title: `部署经验第${i}条：上线前检查端口`, content: `正文 ${i}`, scope: 'global', type: i % 2 ? 'skill' : 'decision', salience: i === 0 ? 1 : 2 }] });
    }
    const entries = await core.loadAllEntries(stores);
    const full = core.renderMemoryCatalog(entries);
    const refs = [...full.matchAll(/^- \[([0-9a-f]{6})\] 部署经验/gm)].map(m => m[1]);
    assert.equal(refs.length, 12);
    assert.doesNotMatch(full, /^- \[(global|project) \|/m);
    assert.doesNotMatch(full, /另有/);

    const loaded = await core.loadEntryById(stores, refs[0], { touchAccess: false });
    assert.equal(core.shortRef(loaded.id), refs[0]);
    assert.equal((await core.loadEntryById(stores, loaded.id, { touchAccess: false })).id, loaded.id);
    assert.equal(await core.loadEntryById(stores, 'ffffff', { touchAccess: false }), null);

    const small = core.renderMemoryCatalog(entries, { maxChars: 700, searchTool: 'plugin_search' });
    assert.ok(small.length <= 700, `catalog length ${small.length}`);
    assert.match(small, /部署经验第0条/);
    assert.match(small, /另有 \d+ 条未列出（[^）]*(skill|decision) \d+[^）]*）：用 plugin_search\(type\)/);

    const browse = core.searchEntries(entries, '', { type: 'skill', limit: 20 });
    assert.equal(browse.length, 6);
    assert.ok(browse.every(h => h.entry.type === 'skill'));
    assert.deepEqual(core.searchEntries(entries, '', {}), []);

    const seen = new Map();
    let pair = null;
    for (let i = 0; !pair; i++) {
      const id = `clash-${i}`;
      const ref = core.shortRef(id);
      if (seen.has(ref)) pair = [seen.get(ref), id];
      else seen.set(ref, id);
    }
    const twins = pair.map((id, n) => ({ ...entries[0], id, title: `撞车条目${n}` }));
    const twinCatalog = core.renderMemoryCatalog(twins);
    assert.match(twinCatalog, new RegExp(`\\[${pair[0]}\\]`));
    assert.match(twinCatalog, new RegExp(`\\[${pair[1]}\\]`));
    assert.equal(core.findEntryByRef(twins, core.shortRef(pair[0])), null);
    assert.equal(core.findEntryByRef(twins, pair[1]).id, pair[1]);

    const forgot = await core.forgetEntry(stores, { id: refs[1], mode: 'deprecate' });
    assert.equal(forgot.status, 'deprecated');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('usage: load and injection go to state/usage.json, dormant entries sink in catalog and wake on use', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    const old = isoDaysAgo(200);
    await writeEntry(globalDir, 'skills/old-skill.md', { id: 'old-skill', scope: 'global', type: 'skill', title: '旧经验 nginx 反向代理', summary: '旧', salience: 2, status: 'active', created_at: old, updated_at: old, last_access: old });
    await writeEntry(globalDir, 'skills/old-core.md', { id: 'old-core', scope: 'global', type: 'skill', title: '核心约束', summary: '始终相关', salience: 1, status: 'active', created_at: old, updated_at: old });
    await writeEntry(globalDir, 'user/old-pref.md', { id: 'old-pref', scope: 'global', type: 'user', title: '用户偏好中文', summary: '偏好', salience: 2, status: 'active', created_at: old, updated_at: old });
    await writeEntry(globalDir, 'skills/fresh.md', { id: 'fresh', scope: 'global', type: 'skill', title: '新经验', summary: '新', salience: 2, status: 'active', created_at: core.todayStr(), updated_at: core.todayStr() });

    let entries = await core.loadAllEntries(stores);
    const byId = id => entries.find(e => e.id === id);
    assert.equal(core.isDormant(byId('old-skill'), {}), true);
    assert.equal(core.isDormant(byId('old-core'), {}), false);
    assert.equal(core.isDormant(byId('old-pref'), {}), false);
    assert.equal(core.isDormant(byId('fresh'), {}), false);

    const catalog = core.renderMemoryCatalog(entries);
    const order = [...catalog.matchAll(/^- \[[^\]]+\] (.+?)(?: — .*)?$/gm)].map(m => m[1]);
    assert.equal(order.at(-1), '旧经验 nginx 反向代理');
    const lint = await core.lintStore(stores);
    assert.deepEqual(lint.issues.filter(i => i.code === 'stale_cold_memory').map(i => i.id), ['old-skill']);

    const before = await fsp.readFile(path.join(globalDir, 'skills/old-skill.md'), 'utf8');
    await core.loadEntryById(stores, 'old-skill');
    assert.equal(await fsp.readFile(path.join(globalDir, 'skills/old-skill.md'), 'utf8'), before);
    let usage = await core.readUsage(stores);
    assert.equal(usage['old-skill'].loads, 1);
    assert.equal(await fsp.readFile(path.join(globalDir, 'state/.gitignore'), 'utf8'), '*\n!.gitignore\n');

    const injected = await core.retrieveContext(stores, { query: 'nginx 反向代理怎么配', rerank: null });
    assert.ok(injected.ids.includes('old-skill'));
    usage = await core.readUsage(stores);
    assert.equal(usage['old-skill'].injections, 1);

    entries = await core.loadAllEntries(stores);
    assert.equal(core.isDormant(byId('old-skill'), usage), false);
    assert.equal((await core.lintStore(stores)).issues.filter(i => i.code === 'stale_cold_memory').length, 0);

    await fsp.writeFile(path.join(globalDir, 'state/usage.json'), '{broken');
    assert.deepEqual(await core.readUsage(stores), {});
    await core.loadEntryById(stores, 'fresh');
    assert.equal((await core.readUsage(stores)).fresh.loads, 1);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('hook: session boot, compact reset, tool-failure retrieval, and Stop handoff nudge', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  const cacheDir = path.join(base, 'cache');
  const run = (event, payload) => runHook({ event, payload: { cwd: repoDir, session_id: 's1', ...payload }, homeDir, globalDir, cacheDir, fetchImpl: null });
  const prevRerank = process.env.MEMHUB_RERANK_URL;
  delete process.env.MEMHUB_RERANK_URL;
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    await core.proposeMemory(stores, {
      items: [{ title: '生产镜像必须指定 linux/amd64 架构', content: 'exec format error 说明架构不匹配', scope: 'global', type: 'skill', keywords: ['docker', 'exec format error'] }],
    });

    const start = JSON.parse(await run('SessionStart', { source: 'startup' }));
    assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(start.hookSpecificOutput.additionalContext, /<memory-catalog/);

    const first = JSON.parse(await run('UserPromptSubmit', { prompt: 'docker 镜像 amd64 怎么构建' }));
    assert.match(first.hookSpecificOutput.additionalContext, /linux\/amd64/);
    assert.deepEqual(JSON.parse(await run('UserPromptSubmit', { prompt: 'docker 镜像 amd64 再确认' })), {});

    await run('SessionStart', { source: 'compact' });
    const afterCompact = JSON.parse(await run('UserPromptSubmit', { prompt: 'docker 镜像 amd64 再确认' }));
    assert.match(afterCompact.hookSpecificOutput.additionalContext, /linux\/amd64/);

    await run('SessionStart', { source: 'compact' });
    const failure = JSON.parse(await run('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'docker run app' }, error: 'exec format error' }));
    assert.equal(failure.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
    assert.match(failure.hookSpecificOutput.additionalContext, /linux\/amd64/);

    await run('UserPromptSubmit', { prompt: '改一下代码' });
    await run('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(repoDir, 'src', 'a.js') } });
    const stop = JSON.parse(await run('Stop', { stop_hook_active: false }));
    assert.equal(stop.decision, 'block');
    assert.match(stop.reason, /交接单/);
    assert.deepEqual(JSON.parse(await run('Stop', { stop_hook_active: true })), {});

    await run('UserPromptSubmit', { prompt: '再改一下' });
    await run('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(repoDir, 'src', 'b.js') } });
    await run('PostToolUse', { tool_name: 'mcp__memhub__memory_propose', tool_input: { items: [{ scope: 'handoff', title: 't', content: 'c' }] } });
    assert.doesNotMatch(JSON.parse(await run('Stop', { stop_hook_active: false })).reason || '', /还没有更新任务交接单/);
  } finally {
    if (prevRerank !== undefined) process.env.MEMHUB_RERANK_URL = prevRerank;
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('cli setup: uninstall removes only memhub entries and keeps later user edits', async () => {
  const { base, homeDir } = await makeTempWorkspace();
  try {
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    await fsp.writeFile(settingsPath, JSON.stringify({ model: 'sonnet', hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node "/old/memhub/packages/cli/bin/memhub.js" hook claude-code --event SessionEnd' }] }],
    } }));
    await fsp.writeFile(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: { a: 1 }, mcpServers: { other: { command: 'x' } } }));

    await installForAgent('claude', { homeDir });
    await installForAgent('claude', { homeDir });
    const installed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(installed.hooks.Stop.length, 2);
    assert.equal(installed.hooks.PostToolUseFailure.length, 1);
    assert.equal(installed.hooks.SessionEnd, undefined);

    installed.theme = 'dark';
    fs.writeFileSync(settingsPath, JSON.stringify(installed));
    const claudeJson = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8'));
    claudeJson.projects.b = 2;
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify(claudeJson));

    await uninstallFromHome(homeDir);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(after.theme, 'dark');
    assert.deepEqual(after.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] });
    const afterJson = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8'));
    assert.deepEqual(afterJson, { projects: { a: 1, b: 2 }, mcpServers: { other: { command: 'x' } } });

    const codexHome = path.join(base, 'codex-relay');
    await installForAgent('codex', { homeDir, env: { CODEX_HOME: codexHome } });
    assert.ok(fs.existsSync(path.join(codexHome, 'config.toml')));
    assert.equal(fs.existsSync(path.join(homeDir, '.codex', 'config.toml')), false);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('daemon: forget passes explicit confirm for physical delete', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  const { server, url } = await startDaemon({ port: 0, homeDir, globalDir, defaultCwd: repoDir });
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    const res = await core.proposeMemory(stores, { items: [{ title: '待删除条目', content: 'x', scope: 'project' }] });
    const id = res.committed[0].id;
    const post = body => fetch(`${url}/api/forget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: repoDir, id, mode: 'delete', ...body }) });
    assert.equal((await post({})).status, 500);
    assert.equal((await post({ confirm: true })).status, 200);
    assert.equal(await core.loadEntryById(stores, id, { touchAccess: false }), null);
  } finally {
    server.close();
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('adapter: pi-desktop injects boot catalog once and retrieves after failing tools', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  const prevGlobal = process.env.MEMHUB_GLOBAL_DIR;
  process.env.MEMHUB_GLOBAL_DIR = globalDir;
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    await core.proposeMemory(stores, {
      items: [{ title: '生产镜像必须指定 linux/amd64 架构', content: 'exec format error', scope: 'global', type: 'skill', keywords: ['exec format error'] }],
    });
    const extPath = path.resolve(__dirname, '../adapters/pi-desktop/extension.js');
    delete require.cache[require.resolve(extPath)];
    const register = require(extPath);
    const handlers = {};
    register({ on: (evt, fn) => { handlers[evt] = fn; } });
    const ctx = { cwd: repoDir, sessionManager: { getSessionId: () => 'pi-s1' } };

    const payload = { messages: [{ role: 'user', content: '你好' }] };
    const next = await handlers.before_provider_request({ payload }, ctx);
    assert.match(next.messages[0].content, /<memory-boot/);
    assert.match(next.messages[0].content, /plugin_memhub_universal_memory_load/);
    const again = await handlers.before_provider_request({ payload: { messages: [...payload.messages, { role: 'assistant', content: '嗨' }, { role: 'user', content: '在吗' }] } }, ctx);
    assert.equal((again.messages[0].content.match(/<memory-boot/g) || []).length, 1);
    assert.doesNotMatch(again.messages[2].content, /<memory-boot/);

    const failed = await handlers.tool_result({ toolName: 'bash', isError: true, input: { command: 'docker run app' }, content: [{ type: 'text', text: 'exec format error' }] }, ctx);
    assert.match(failed.content[1].text, /linux\/amd64/);
    const ok = await handlers.tool_result({ toolName: 'bash', isError: false, input: { command: 'ls' }, content: [{ type: 'text', text: 'ok' }] }, ctx);
    assert.equal(ok, undefined);
  } finally {
    if (prevGlobal === undefined) delete process.env.MEMHUB_GLOBAL_DIR;
    else process.env.MEMHUB_GLOBAL_DIR = prevGlobal;
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('core: concurrent proposals serialize the whole read-modify-write', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    const stores = () => core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    const handoffs = await Promise.all([1, 2, 3].map(n => core.proposeMemory(stores(), {
      agent: `a${n}`,
      items: [{ scope: 'handoff', task: 'feat-x', title: `任务X ${n}`, content: `进度 ${n}` }],
    })));
    assert.deepEqual(handoffs.map(r => r.committed[0].action).sort(), ['create', 'update', 'update']);

    const sameTitle = await Promise.all([1, 2].map(n => core.proposeMemory(stores(), {
      items: [{ scope: 'global', type: 'skill', title: '同名经验', content: `版本 ${n}` }],
    })));
    const ids = sameTitle.map(r => r.committed[0].id);
    assert.notEqual(ids[0], ids[1]);

    const projectLog = await fsp.readFile(path.join(repoDir, '.memory', 'log.md'), 'utf8');
    assert.equal(projectLog.split('\n').filter(l => l.includes('handoff-')).length, 3);
    const all = await core.loadAllEntries(stores());
    assert.equal(all.filter(e => e.scope === 'handoff').length, 1);
    assert.equal(all.filter(e => e.title === '同名经验' && core.isActiveEntry(e)).length, 1);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('core: frontmatter round-trips hostile and scalar-looking strings', async () => {
  const { base, homeDir, globalDir } = await makeTempWorkspace();
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: base });
    const res = await core.proposeMemory(stores, { items: [
      { scope: 'global', type: 'skill', title: '正常标题', summary: 'x\n---\nstatus: deprecated', content: '正文' },
      { scope: 'global', type: 'decision', title: '2024', content: '数字标题' },
      { scope: 'global', type: 'decision', title: 'true', content: '布尔标题' },
    ] });
    const entries = await core.loadAllEntries(stores);
    const byId = id => entries.find(e => e.id === id);
    const [hostile, year, bool] = res.committed.map(c => byId(c.id));
    assert.equal(hostile.status, 'active');
    assert.equal(hostile.summary, 'x --- status: deprecated');
    assert.equal(hostile.body, '正文');
    assert.equal(year.title, '2024');
    assert.equal(bool.title, 'true');

    await fsp.writeFile(path.join(globalDir, 'skills', 'hand.md'), '---\ntitle: 404\n---\n手写');
    assert.equal((await core.loadAllEntries(stores)).find(e => e.relPath === 'skills/hand.md').title, '404');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('core: rejects secrets and invisible characters before writing', async () => {
  const { base, homeDir, globalDir } = await makeTempWorkspace();
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: base });
    const propose = content => core.proposeMemory(stores, { items: [{ scope: 'global', title: '凭据', content }] });
    await assert.rejects(() => propose('key sk-abcdefghijklmnopqrstuvwxyz123456'), /API Key/);
    await assert.rejects(() => propose('-----BEGIN OPENSSH PRIVATE KEY-----'), /私钥/);
    await assert.rejects(() => propose('password = hunter2hunter2hunter2'), /凭据赋值/);
    await assert.rejects(() => propose('看起来正常\u200b'), /不可见/);
    await propose('Key 路径：~/.ssh/staging_ed25519，端口 2222');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('search: english terms match on word boundaries, CJK stays substring', () => {
  const entry = (id, title) => ({ id, title, summary: '', body: '', keywords: [], triggers: [], status: 'active', salience: 2, scope: 'global' });
  const entries = [entry('noise', 'Rapid prototyping with Goodreads'), entry('real', 'Go API 网关 rate-limit')];
  assert.deepEqual(core.searchEntries(entries, 'go api', { strict: true }).map(h => h.entry.id), ['real']);
  assert.deepEqual(core.searchEntries(entries, 'limit', {}).map(h => h.entry.id), ['real']);
  assert.deepEqual(core.searchEntries(entries, '网关配置', {}).map(h => h.entry.id), ['real']);
});

test('core: archiving a global handoff keeps the global index title', async () => {
  const { base, homeDir, globalDir } = await makeTempWorkspace();
  try {
    const outside = path.join(homeDir, 'Desktop', 'plan');
    await fsp.mkdir(outside, { recursive: true });
    const stores = core.resolveStores({ homeDir, globalDir, cwd: outside });
    const res = await core.proposeMemory(stores, { items: [{ scope: 'handoff', task: 't', title: '临时任务', content: '- [ ] a' }] });
    await core.forgetEntry(stores, { id: res.committed[0].id, mode: 'archive' });
    assert.match(await fsp.readFile(path.join(globalDir, 'index.md'), 'utf8'), /^# 全局记忆路由表/);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

test('self-check: claude Stop throttles by turn interval, fires on PreCompact, and can be disabled', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  const cacheDir = path.join(base, 'cache');
  const run = (event, payload = {}) => runHook({
    event,
    payload: { cwd: repoDir, session_id: 's-self', stop_hook_active: false, ...payload },
    homeDir, globalDir, cacheDir, fetchImpl: null,
  });
  try {
    await run('SessionStart', { source: 'startup' });
    for (let i = 1; i <= 4; i++) {
      await run('UserPromptSubmit', { prompt: `第 ${i} 轮普通问答` });
      assert.deepEqual(JSON.parse(await run('Stop')), {});
    }
    await run('UserPromptSubmit', { prompt: '以后提交信息都用中文' });
    const stop = JSON.parse(await run('Stop'));
    assert.equal(stop.decision, 'block');
    assert.ok(stop.reason.startsWith(core.SELF_CHECK_MARKER));
    assert.match(stop.reason, /memory_propose/);
    assert.match(stop.reason, /YYYY-MM-DD/);
    assert.match(stop.reason, /supersedes/);
    assert.doesNotMatch(stop.reason, /交接单。$/);
    assert.deepEqual(JSON.parse(await run('Stop', { stop_hook_active: true })), {});

    await run('PreCompact', {});
    await run('UserPromptSubmit', { prompt: '压缩前再确认一句' });
    assert.equal(JSON.parse(await run('Stop')).decision, 'block');

    await withEnv({ MEMHUB_SELF_CHECK_EVERY_TURNS: '1' }, async () => {
      await run('UserPromptSubmit', { prompt: '单轮也检查' });
      assert.equal(JSON.parse(await run('Stop')).decision, 'block');
    });

    await withEnv({ MEMHUB_SELF_CHECK: '0', MEMHUB_SELF_CHECK_EVERY_TURNS: '1' }, async () => {
      await run('UserPromptSubmit', { prompt: '关闭后不检查' });
      assert.deepEqual(JSON.parse(await run('Stop')), {});
    });
    await fsp.mkdir(globalDir, { recursive: true });
    await fsp.writeFile(path.join(globalDir, 'config.json'), JSON.stringify({ selfCheck: { enabled: false, everyTurns: 1 } }));
    await run('UserPromptSubmit', { prompt: '配置关闭' });
    assert.deepEqual(JSON.parse(await run('Stop')), {});
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('self-check: pi-desktop throttles by interval, triggers near context limit, and keeps check out of journals', async () => {
  const { base, globalDir, repoDir } = await makeTempWorkspace();
  try {
    await withEnv({ MEMHUB_GLOBAL_DIR: globalDir, MEMHUB_SELF_CHECK_EVERY_TURNS: '2', MEMHUB_SELF_CHECK_CONTEXT_CHARS: '2500' }, async () => {
      const extPath = path.resolve(__dirname, '../adapters/pi-desktop/extension.js');
      delete require.cache[require.resolve(extPath)];
      const { onProviderRequest, onToolResult, onAgentEnd, onAgentSettled, TOOLS } = require(extPath)._internals;
      const sent = [];
      const pi = { sendUserMessage: async text => { sent.push(text); } };
      const ctx = { cwd: repoDir, sessionId: 'pi-self' };
      const turn = (text, reply, ts) => [
        { role: 'user', content: text, timestamp: ts },
        { role: 'assistant', content: [{ type: 'text', text: reply }], timestamp: ts + 1000 },
      ];

      await onAgentEnd({ messages: turn('第一轮普通提问', '普通回答', 1700000000000) }, ctx);
      await onAgentSettled({ aborted: false }, ctx, pi);
      assert.equal(sent.length, 0);

      const turn2 = turn('以后部署前都先跑 smoke 测试', '收到', 1700000002000);
      await onAgentEnd({ messages: turn2 }, ctx);
      await onAgentSettled({ aborted: false }, ctx, pi);
      assert.equal(sent.length, 1);
      assert.ok(sent[0].startsWith(core.SELF_CHECK_MARKER));
      assert.match(sent[0], new RegExp(TOOLS.propose));
      await onAgentSettled({ aborted: false }, ctx, pi);
      assert.equal(sent.length, 1);

      const checkTurn = [
        { role: 'user', content: sent[0], timestamp: 1700000004000 },
        { role: 'assistant', content: [{ type: 'text', text: '无需记录' }], timestamp: 1700000005000 },
      ];
      const checkPayload = await onProviderRequest({ payload: { messages: [...turn2, checkTurn[0]] } }, ctx);
      assert.equal(checkPayload.messages.at(-1).content, sent[0]);
      await onAgentEnd({ messages: checkTurn }, ctx);
      await onAgentSettled({ aborted: false }, ctx, pi);
      assert.equal(sent.length, 1);

      await onToolResult({ toolName: TOOLS.propose, isError: false, input: { items: [] }, content: [] }, ctx);
      await onAgentEnd({ messages: turn('主动写过记忆的一轮', '已记录', 1700000006000) }, ctx);
      await onAgentSettled({ aborted: false }, ctx, pi);
      assert.equal(sent.length, 1);

      const bigTurn = turn('接近上下文上限的对话', '长回复'.repeat(1000), 1700000008000);
      await onProviderRequest({ payload: { messages: bigTurn } }, ctx);
      await onAgentEnd({ messages: bigTurn }, ctx);
      await onAgentSettled({ aborted: false }, ctx, pi);
      assert.equal(sent.length, 2);

      await onAgentEnd({ messages: [{ role: 'user', content: '下一个问题', timestamp: 1700000010000 }] }, ctx);
      await onAgentSettled({ aborted: true }, ctx, pi);
      assert.equal(sent.length, 2);

      const stores = core.resolveStores({ globalDir, cwd: repoDir });
      const [session] = await core.listSessions(stores);
      const texts = (await core.loadSession(stores, { session_key: session.session_key })).messages.map(m => m.text);
      assert.ok(!texts.some(t => t.startsWith(core.SELF_CHECK_MARKER)));
      assert.ok(texts.includes('下一个问题'));
    });
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('propose & entities: returns similar candidates, supersedes by ref, and expands 1-hop entity links', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  try {
    const stores = core.resolveStores({ homeDir, globalDir, cwd: repoDir });
    const first = await core.proposeMemory(stores, {
      items: [{ title: '生产镜像必须指定 linux/amd64', summary: 'Mac 编译部署到 relay.example.net', content: '使用 `--platform linux/amd64` 打包推送到 `relay.example.net`。', scope: 'global', type: 'skill', keywords: ['linux/amd64', 'relay.example.net'] }],
    });
    const firstId = first.committed[0].id;

    const related = await core.proposeMemory(stores, {
      items: [{ title: '服务运行在东京主机 `tokyo-edge` 上', summary: 'relay.example.net 的部署机器', content: '`claude-remote` 跑在 `tokyo-edge`（`relay.example.net`），通过 `Caddy` 反代。', scope: 'global', type: 'project', keywords: ['claude-remote', 'tokyo-edge'] }],
    });
    assert.equal(related.committed[0].similar[0].id, firstId);
    assert.equal(related.committed[0].similar[0].ref, core.shortRef(firstId));

    const caddyTip = await core.proposeMemory(stores, {
      items: [{ title: 'Caddy 配置 redir 必须带路径匹配器', summary: '反代跳转踩坑', content: '在 `tokyo-edge` 上改 `Caddyfile` 时，`redir` 必须写 `redir * /to`。', scope: 'global', type: 'skill', keywords: ['Caddy', 'Caddyfile'] }],
    });

    const replaced = await core.proposeMemory(stores, {
      items: [{ title: '生产镜像改用多架构 manifest 自动构建', summary: 'CI 已接管构建', content: '不再手动指定单平台参数，统一由 GitHub Actions 构建 `linux/amd64` 与 `arm64`。', scope: 'global', type: 'decision', supersedes: [core.shortRef(firstId)] }],
    });
    assert.equal(replaced.committed[0].action, 'supersede');
    assert.deepEqual(replaced.committed[0].supersededIds, [firstId]);
    const oldEntry = (await core.loadAllEntries(stores)).find(e => e.id === firstId);
    assert.equal(oldEntry.status, 'deprecated');
    assert.equal(oldEntry.supersededBy, replaced.committed[0].id);

    const retrieved = await core.retrieveContext(stores, { query: 'claude-remote 为什么连不上？', rerank: null });
    assert.ok(retrieved.ids.includes(related.committed[0].id));
    assert.ok(retrieved.linkedIds.includes(caddyTip.committed[0].id));
    assert.match(retrieved.block || '', /## 关联记忆/);
    assert.match(retrieved.block || '', new RegExp(`\\[${core.shortRef(caddyTip.committed[0].id)}\\]`));
    assert.match(retrieved.block || '', /tokyo-edge/);
    assert.ok(fs.existsSync(path.join(globalDir, 'state/entities.json')));
    assert.equal(fs.readFileSync(path.join(globalDir, 'state/.gitignore'), 'utf8'), '*\n!.gitignore\n');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('model config: file works without shell exports and environment overrides it', async () => {
  const { base, globalDir } = await makeTempWorkspace();
  const env = { MEMHUB_GLOBAL_DIR: globalDir };
  const file = path.join(globalDir, 'config.json');
  const RERANK_ENV = { MEMHUB_RERANK_URL: 'https://example.com/v1', MEMHUB_RERANK_MODEL: 'small' };
  try {
    assert.equal(core.rerankConfig(env), null);
    await fsp.mkdir(globalDir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ review: { url: 'http://x/v1', model: 'ignored' }, rerank: {
      url: 'http://127.0.0.1:3425/v1/', model: 'example/light-model', reasoningEffort: 'low', timeoutMs: 60000,
    } }));
    const config = core.rerankConfig(env);
    assert.equal(config.url, 'http://127.0.0.1:3425/v1/chat/completions');
    assert.equal(config.model, 'example/light-model');
    assert.equal(config.reasoningEffort, 'low');
    assert.equal(config.apiKey, '');
    assert.equal(core.reviewConfig, undefined);

    const override = core.rerankConfig({ ...env, ...RERANK_ENV, MEMHUB_RERANK_REASONING_EFFORT: 'none' });
    assert.equal(override.url, 'https://example.com/v1/chat/completions');
    assert.equal(override.model, 'small');
    assert.equal(override.reasoningEffort, 'none');
    assert.equal(core.rerankConfig({ ...env, MEMHUB_RERANK_ENABLED: '0' }), null);

    let request;
    const text = await core.chatCompletion(config, [{ role: 'user', content: '测试' }], {
      maxTokens: 1500,
      fetchImpl: async (url, init) => {
        request = { url, ...init, body: JSON.parse(init.body) };
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"items":[]}' } }] }) };
      },
    });
    assert.equal(text, '{"items":[]}');
    assert.equal(request.body.reasoning_effort, 'low');
    assert.equal(request.headers['User-Agent'], 'memhub/1');
    assert.equal(request.headers.Authorization, undefined);

    await fsp.writeFile(file, JSON.stringify({ rerank: { enabled: false, url: config.url, model: config.model } }));
    assert.equal(core.rerankConfig(env), null);
    assert.ok(core.rerankConfig({ ...env, MEMHUB_RERANK_ENABLED: '1' }));
    await fsp.writeFile(file, '{broken');
    assert.equal(core.rerankConfig(env), null);
    assert.equal(core.rerankConfig({ ...env, ...RERANK_ENV }).model, 'small');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('adapter: project progress targets another workspace and updates only its handoff', async () => {
  const { base, homeDir, globalDir, repoDir } = await makeTempWorkspace();
  const targetDir = path.join(base, 'target');
  const otherDir = path.join(base, 'other');
  await fsp.mkdir(path.join(targetDir, '.git'), { recursive: true });
  await fsp.mkdir(path.join(otherDir, '.git'), { recursive: true });
  try {
    await withEnv({ MEMHUB_GLOBAL_DIR: globalDir }, async () => {
      const { tools } = require('../adapters/pi-desktop/main')._internals;
      const ctx = { cwd: repoDir, sessionId: 'cross-project-test' };
      const progress = content => ({ scope: 'handoff', task: 'project-status', title: '项目当前进度', content });
      const first = await tools.propose({ cwd: targetDir, items: [progress('进入动作细调阶段')] }, ctx);
      assert.equal(first.committed[0].rootDir, path.join(targetDir, '.memory'));
      assert.equal(fs.existsSync(path.join(repoDir, '.memory')), false);
      const second = await tools.propose({ cwd: targetDir, items: [progress('继续细调，翻页动作已完成')] }, ctx);
      assert.equal(second.committed[0].action, 'update');
      assert.equal(second.committed[0].id, first.committed[0].id);
      await tools.propose({ cwd: otherDir, items: [progress('已公开仓库并宣传')] }, ctx);

      const stores = cwd => core.resolveStores({ homeDir, globalDir, cwd });
      const targetEntries = await core.loadAllEntries(stores(targetDir));
      assert.equal(targetEntries.filter(e => e.scope === 'handoff').length, 1);
      assert.equal(targetEntries.filter(e => e.scope === 'global').length, 0);
      assert.match((await tools.load({ cwd: targetDir, id: first.committed[0].id }, ctx)).content, /翻页动作已完成/);
      assert.equal((await tools.search({ cwd: targetDir, query: '翻页动作' }, ctx)).hits[0].scope, 'handoff');
      assert.match(core.renderBootBlock(await core.bootContext(stores(targetDir))), /翻页动作已完成/);
      assert.doesNotMatch(core.renderBootBlock(await core.bootContext(stores(repoDir))), /翻页动作已完成|已公开仓库并宣传/);
      assert.doesNotMatch(core.renderBootBlock(await core.bootContext(stores(otherDir))), /翻页动作已完成/);

      await tools.propose({ items: [{ ...progress('当前会话的进度'), paths: [targetDir] }] }, ctx);
      assert.match((await core.loadAllEntries(stores(repoDir))).find(e => e.scope === 'handoff').body, /当前会话的进度/);
      assert.equal((await core.loadAllEntries(stores(targetDir))).filter(e => e.scope === 'handoff').length, 1);
      await assert.rejects(tools.propose({ cwd: 'target', items: [progress('错误目录')] }, ctx), /absolute path/);
      await assert.rejects(tools.propose({ cwd: path.join(base, 'missing'), items: [progress('错误目录')] }, ctx), /existing project directory/);
      const emptyDir = path.join(base, 'empty');
      await fsp.mkdir(emptyDir);
      await assert.rejects(tools.propose({ cwd: emptyDir, items: [progress('错误目录')] }, ctx), /does not identify a project/);
      assert.equal(fs.existsSync(path.join(emptyDir, '.memory')), false);

      await tools.forget({ cwd: targetDir, id: first.committed[0].id, mode: 'deprecate', reason: '测试结束' }, ctx);
      assert.equal((await tools.load({ cwd: targetDir, id: first.committed[0].id }, ctx)).status, 'deprecated');
      assert.equal((await core.loadAllEntries(stores(otherDir))).find(e => e.scope === 'handoff').status, 'active');
    });
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('protocol: project progress uses targeted handoffs rather than global long-term memory', () => {
  const protocol = core.renderProtocol();
  assert.match(protocol, /最新进度.*不属于长期记忆/);
  assert.match(protocol, /task="project-status"/);
  assert.match(protocol, /cwd 参数决定目标项目/);
  assert.match(protocol, /未提供.*不要编造/);
  assert.match(core.selfCheckPrompt(), /写入对应项目的短期交接/);
  for (const tool of require('../adapters/pi-desktop/manifest.json').contributes.agentTools) {
    assert.equal(tool.schema.properties.cwd.type, 'string');
  }
});
