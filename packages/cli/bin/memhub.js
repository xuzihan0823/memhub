#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const core = require('../../core/src');
const { startDaemon } = require('../../daemon/src/server');
const { startStdioMcpServer } = require('../../mcp-server/src/server');
const { detectAgents, installForAgent, uninstallFromHome } = require('../src/setup');
const { runHook } = require('../src/hook');

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function readStdinText(timeoutMs = 3000) {
  if (process.stdin.isTTY) return '';
  return new Promise(resolve => {
    let data = '';
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function handleHook(flags) {
  const raw = await readStdinText();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const event = String(flags.event || payload.hook_event_name || 'UserPromptSubmit');
  try {
    process.stdout.write(await runHook({ event, payload, flags }));
  } catch (err) {
    process.stderr.write(`memhub hook ${event} failed: ${err?.message || err}\n`);
    process.stdout.write('{}');
  }
}

async function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const cmd = positional[0] || 'help';

  if (cmd === 'serve' || cmd === 'ui') {
    const port = Number(flags.port || process.env.MEMHUB_PORT || 4789);
    const { url } = await startDaemon({ port, defaultCwd: flags.cwd || process.cwd() });
    console.log(`MemHub daemon & Web UI running at ${url}`);
    return;
  }

  if (cmd === 'mcp') {
    startStdioMcpServer({ cwd: flags.cwd || process.cwd() });
    return;
  }

  if (cmd === 'hook') {
    await handleHook(flags);
    return;
  }

  if (cmd === 'session') {
    const stores = core.resolveStores({ cwd: flags.cwd || process.cwd() });
    const action = positional[1] || 'status';
    let input = {};
    if (['capture', 'restore'].includes(action)) input = JSON.parse(await readStdinText() || '{}');
    Object.assign(input, {
      ...(flags.key ? { session_key: flags.key } : {}),
      ...(flags.agent ? { origin_agent: flags.agent } : {}),
      ...(flags.session ? { source_session_id: flags.session } : {}),
      ...(flags.from ? { from_seq: Number(flags.from) } : {}),
      ...(flags.to ? { to_seq: Number(flags.to) } : {}),
      ...(flags['workspace-root'] ? { workspace_root: flags['workspace-root'] } : {}),
      ...(flags['workspace-roots'] ? { workspace_roots: JSON.parse(flags['workspace-roots']) } : {}),
      ...(flags['cross-workspace'] ? { cross_workspace: true } : {}),
    });
    const handler = action === 'summarize' ? core.summarizeSession : action === 'rebuild' ? core.rebuildSessionLocations : (target, args) => core.handleSessionTool(`session_${action}`, target, args);
    const result = await handler(stores, input);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'init' || cmd === 'setup') {
    const dryRun = Boolean(flags['dry-run']);
    const stores = core.resolveStores({ cwd: flags.cwd || process.cwd() });
    if (!dryRun) {
      await core.scaffoldGlobalStore(stores.globalDir);
      if (flags.project) await core.scaffoldProjectStore(stores.projectDir);
    }
    const detected = detectAgents();
    const requested = flags.agents ? String(flags.agents).split(',').map(s => s.trim()) : detected.filter(a => a.installed).map(a => a.id);
    const actions = [];
    for (const id of requested) {
      actions.push(...await installForAgent(id, { dryRun }));
    }
    console.log(JSON.stringify({
      dryRun,
      globalDir: stores.globalDir,
      detectedAgents: detected.map(a => ({ id: a.id, name: a.name, installed: a.installed })),
      applied: actions,
    }, null, 2));
    return;
  }

  if (cmd === 'uninstall') {
    const restored = await uninstallFromHome();
    console.log(JSON.stringify({ restored }, null, 2));
    return;
  }

  if (cmd === 'doctor') {
    const stores = core.resolveStores({ cwd: flags.cwd || process.cwd() });
    const detected = detectAgents();
    const lint = fs.existsSync(stores.globalDir) ? await core.lintStore(stores) : { total: 0, active: 0, issues: [] };
    console.log(JSON.stringify({
      ok: true,
      node: process.version,
      globalDir: stores.globalDir,
      globalExists: fs.existsSync(stores.globalDir),
      projectDir: stores.projectDir,
      projectExists: Boolean(stores.projectDir && fs.existsSync(stores.projectDir)),
      lint,
      sessions: await core.sessionDiagnostics(stores),
      agents: detected.map(a => ({ id: a.id, name: a.name, installed: a.installed, configExists: a.configExists })),
    }, null, 2));
    return;
  }

  if (cmd === 'search') {
    const query = positional.slice(1).join(' ');
    const stores = core.resolveStores({ cwd: flags.cwd || process.cwd() });
    const entries = await core.loadAllEntries(stores);
    const hits = core.searchEntries(entries, query, { limit: Number(flags.limit || 8) });
    console.log(JSON.stringify(hits.map(h => ({
      id: h.entry.id,
      scope: h.entry.scope,
      title: h.entry.title,
      summary: h.entry.summary,
      score: h.score,
    })), null, 2));
    return;
  }

  if (cmd === 'lint') {
    const stores = core.resolveStores({ cwd: flags.cwd || process.cwd() });
    console.log(JSON.stringify(await core.lintStore(stores), null, 2));
    return;
  }

  if (cmd === 'inbox') {
    const stores = core.resolveStores({ cwd: flags.cwd || process.cwd() });
    console.log(JSON.stringify(await core.listInboxBatches(stores), null, 2));
    return;
  }

  if (cmd === 'review') {
    const stores = core.resolveStores({ cwd: flags.cwd || process.cwd() });
    const messages = core.readClaudeTranscript(flags.transcript);
    console.log(JSON.stringify(await core.reviewConversation(stores, { messages, sessionId: flags.session || null, agent: 'claude-code-review' }), null, 2));
    return;
  }

  if (cmd === 'commit') {
    const batchId = positional[1];
    if (!batchId) throw new Error('Usage: memhub commit <batchId>');
    const stores = core.resolveStores({ cwd: flags.cwd || process.cwd() });
    console.log(JSON.stringify(await core.commitBatch(stores, batchId), null, 2));
    return;
  }

  console.log([
    'MemHub CLI v0.1.0 — 跨 Agent 通用本地记忆系统',
    '',
    'Commands:',
    '  memhub init [--dry-run] [--agents a,b] [--project]   初始化记忆库并探测安装各 Agent',
    '  memhub serve [--port 4789]                          启动本地守护进程与 Web 管理后台',
    '  memhub mcp                                          启动标准 stdio MCP Server',
    '  memhub hook <host> --event <Event>                  各宿主 Hook 桥接入口',
    '  memhub search <query>                               检索全局与当前项目记忆',
    '  memhub session list|load|status|capture|restore|summarize|rebuild [--key KEY] [--cwd DIR]',
    '  memhub inbox / commit <batchId>                     查看或确认待审提案',
    '  memhub review --transcript <jsonl>                  复盘一段 Claude Code 对话，候选记忆进入 inbox',
    '  memhub lint / doctor / uninstall                    体检、诊断与无损卸载',
  ].join('\n'));
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
