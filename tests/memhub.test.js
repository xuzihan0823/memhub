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
    assert.equal(listRpc.result.tools.length, 5);

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
    assert.deepEqual(JSON.parse(await run('Stop', { stop_hook_active: false })), {});
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
    await fsp.writeFile(settingsPath, JSON.stringify({ model: 'sonnet', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    await fsp.writeFile(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: { a: 1 }, mcpServers: { other: { command: 'x' } } }));

    await installForAgent('claude', { homeDir });
    await installForAgent('claude', { homeDir });
    const installed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(installed.hooks.Stop.length, 2);
    assert.equal(installed.hooks.PostToolUseFailure.length, 1);

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
