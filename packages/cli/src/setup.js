'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const MEMHUB_BIN = path.resolve(__dirname, '../bin/memhub.js');
const MEMHUB_MCP = { command: 'node', args: [MEMHUB_BIN, 'mcp'] };
const CLAUDE_HOOK_EVENTS = [
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PostToolUse', 'Edit|Write|MultiEdit|NotebookEdit|Read'],
  ['PostToolUseFailure', null],
  ['PreCompact', null],
  ['Stop', null],
];
const CODEX_HOOK_EVENTS = [
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PostToolUse', 'apply_patch|_propose$|_forget$'],
  ['PreCompact', null],
  ['Stop', null],
];
const CODEX_HOOK_TIMEOUT = 10;
const CODEX_START = '# >>> memhub-mcp >>>';
const CODEX_END = '# <<< memhub-mcp <<<';

function codexHome(homeDir, env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homeDir, '.codex');
}

function detectAgents(homeDir = os.homedir(), env = process.env) {
  const codexDir = codexHome(homeDir, env);
  const candidates = [
    {
      id: 'claude',
      name: 'Claude Code',
      dir: path.join(homeDir, '.claude'),
      configPath: path.join(homeDir, '.claude', 'settings.json'),
      kind: 'hook+mcp',
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      dir: codexDir,
      configPath: path.join(codexDir, 'config.toml'),
      kind: 'mcp+rules',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      dir: path.join(homeDir, '.cursor'),
      configPath: path.join(homeDir, '.cursor', 'mcp.json'),
      kind: 'mcp',
    },
    {
      id: 'pi',
      name: 'Pi CLI',
      dir: path.join(homeDir, '.pi', 'agent'),
      configPath: path.join(homeDir, '.pi', 'agent', 'mcp.json'),
      kind: 'mcp',
    },
    {
      id: 'pi-desktop',
      name: 'PI-Desktop',
      dir: path.join(homeDir, '.pi-desktop'),
      configPath: path.join(homeDir, '.pi-desktop', 'plugins', 'installed', 'memhub.universal-memory'),
      kind: 'plugin',
    },
    {
      id: 'dsh',
      name: 'DeepSeek Harness (DSH)',
      dir: path.join(homeDir, '.dsh'),
      configPath: path.join(homeDir, '.dsh', 'settings.yaml'),
      kind: 'compatible-store',
    },
  ];

  return candidates.map(c => ({
    ...c,
    installed: fs.existsSync(c.dir),
    configExists: fs.existsSync(c.configPath),
  }));
}

async function writeAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.memhub-${process.pid}-${Date.now()}.tmp`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, filePath);
}

async function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = await fsp.readFile(filePath, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

async function patchJsonFile(filePath, mutator, dryRun, summaryNote = '') {
  const current = (await readJson(filePath)) || {};
  const next = mutator(structuredClone(current));
  if (dryRun) return { filePath, action: 'would-update', summary: summaryNote || 'merge memhub config' };
  await writeAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return { filePath, action: 'updated' };
}

async function unpatchJsonFile(filePath, mutator) {
  const current = await readJson(filePath);
  if (!current) return false;
  const before = JSON.stringify(current);
  const next = mutator(current);
  if (JSON.stringify(next) === before) return false;
  await writeAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

function isMemhubHookEntry(entry) {
  const text = JSON.stringify(entry);
  return text.includes(JSON.stringify(MEMHUB_BIN).slice(1, -1)) || /memhub(\.js)?\\?"?\s+hook\b/.test(text);
}

function memhubHookCommand(host, event) {
  return `node ${JSON.stringify(MEMHUB_BIN)} hook ${host} --event ${event}`;
}

function addClaudeHooks(cfg) {
  return addHooks(cfg, CLAUDE_HOOK_EVENTS, event => ({ type: 'command', command: memhubHookCommand('claude-code', event), timeout: 10 }));
}

function codexHookHandler(event) {
  const emitsContext = event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'PostToolUse';
  return { type: 'command', command: memhubHookCommand('codex', event), timeout: CODEX_HOOK_TIMEOUT, ...(emitsContext ? { additionalContextLimit: 0 } : {}) };
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
}

// Mirrors codex-rs hooks discovery `hook_hash`: the normalized group (matcher + single handler with async)
// is key-sorted, serialized as compact JSON and hashed, so pre-trusting avoids the /hooks review prompt.
function codexTrustedHashes(hooksPath, cfg) {
  return CODEX_HOOK_EVENTS.map(([event, matcher]) => {
    const label = event.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();
    const index = cfg.hooks[event].findIndex(isMemhubHookEntry);
    const identity = { event_name: label, ...(matcher ? { matcher } : {}), hooks: [{ async: false, ...cfg.hooks[event][index].hooks[0] }] };
    const hash = crypto.createHash('sha256').update(JSON.stringify(sortKeys(identity))).digest('hex');
    return [`${hooksPath}:${label}:${index}:0`, `sha256:${hash}`];
  });
}

function addHooks(cfg, events, handlerFor) {
  cfg = removeMemhubHooks(cfg);
  cfg.hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
  for (const [event, matcher] of events) {
    const list = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
    list.push({ ...(matcher ? { matcher } : {}), hooks: [handlerFor(event)] });
    cfg.hooks[event] = list;
  }
  return cfg;
}

function removeMemhubHooks(cfg) {
  if (!cfg.hooks || typeof cfg.hooks !== 'object') return cfg;
  for (const event of Object.keys(cfg.hooks)) {
    if (!Array.isArray(cfg.hooks[event])) continue;
    const kept = cfg.hooks[event].filter(entry => !isMemhubHookEntry(entry));
    if (kept.length) cfg.hooks[event] = kept;
    else delete cfg.hooks[event];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  return cfg;
}

function addMcpServer(cfg) {
  cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  cfg.mcpServers.memhub = MEMHUB_MCP;
  return cfg;
}

function removeMcpServer(cfg) {
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object' || !cfg.mcpServers.memhub) return cfg;
  delete cfg.mcpServers.memhub;
  if (!Object.keys(cfg.mcpServers).length) delete cfg.mcpServers;
  return cfg;
}

function stripCodexBlock(raw, trustedKeys = []) {
  let next = raw.replace(new RegExp(`\\n*${CODEX_START}[\\s\\S]*?${CODEX_END}\\n?`), '\n');
  for (const key of trustedKeys) {
    const header = `[hooks.state.${JSON.stringify(key)}]`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    next = next.replace(new RegExp(`\\n*${header}\\n(?:[^\\[\\n].*\\n?)*`, 'g'), '\n');
  }
  return next;
}

async function patchCodexToml(filePath, dryRun, trusted = []) {
  const raw = fs.existsSync(filePath) ? await fsp.readFile(filePath, 'utf8') : '';
  const block = [
    CODEX_START,
    '[mcp_servers.memhub]',
    'command = "node"',
    `args = [${JSON.stringify(MEMHUB_BIN)}, "mcp"]`,
    ...trusted.flatMap(([key, hash]) => ['', `[hooks.state.${JSON.stringify(key)}]`, `trusted_hash = ${JSON.stringify(hash)}`]),
    CODEX_END,
  ].join('\n');
  const base = stripCodexBlock(raw, trusted.map(([key]) => key)).trimEnd();
  const next = `${base ? `${base}\n\n` : ''}${block}\n`;
  if (dryRun) return { filePath, action: 'would-update', preview: block };
  await writeAtomic(filePath, next);
  return { filePath, action: 'updated' };
}

async function installForAgent(agentId, { homeDir = os.homedir(), dryRun = false, env = process.env } = {}) {
  if (agentId === 'claude') {
    const hookRes = await patchJsonFile(
      path.join(homeDir, '.claude', 'settings.json'),
      addClaudeHooks,
      dryRun,
      `add ${CLAUDE_HOOK_EVENTS.map(([e]) => e).join(' / ')} hooks`,
    );
    const mcpRes = await patchJsonFile(path.join(homeDir, '.claude.json'), addMcpServer, dryRun, 'add mcpServers.memhub');
    return [hookRes, mcpRes];
  }

  if (agentId === 'codex') {
    const dir = codexHome(homeDir, env);
    const hooksPath = path.join(dir, 'hooks.json');
    const hooksRes = await patchJsonFile(
      hooksPath,
      cfg => addHooks(cfg, CODEX_HOOK_EVENTS, codexHookHandler),
      dryRun,
      `add ${CODEX_HOOK_EVENTS.map(([e]) => e).join(' / ')} hooks`,
    );
    const trusted = dryRun ? [] : codexTrustedHashes(hooksPath, await readJson(hooksPath));
    return [hooksRes, await patchCodexToml(path.join(dir, 'config.toml'), dryRun, trusted)];
  }

  if (agentId === 'cursor') {
    return [await patchJsonFile(path.join(homeDir, '.cursor', 'mcp.json'), addMcpServer, dryRun, 'add mcpServers.memhub')];
  }

  if (agentId === 'pi') {
    return [await patchJsonFile(path.join(homeDir, '.pi', 'agent', 'mcp.json'), addMcpServer, dryRun, 'add mcpServers.memhub')];
  }

  if (agentId === 'pi-desktop') {
    const srcPlugin = path.resolve(__dirname, '../../../adapters/pi-desktop');
    const srcCore = path.resolve(__dirname, '../../core/src');
    const destPlugin = path.join(homeDir, '.pi-desktop', 'plugins', 'installed', 'memhub.universal-memory');
    if (dryRun) return [{ filePath: destPlugin, action: 'would-copy-plugin', from: srcPlugin }];
    const manifest = JSON.parse(await fsp.readFile(path.join(srcPlugin, 'manifest.json'), 'utf8'));
    const destCore = path.join(destPlugin, 'core', manifest.version, 'src');
    await fsp.mkdir(destCore, { recursive: true });
    for (const f of new Set(['manifest.json', 'main.js', 'extension.js', 'README.md', ...(manifest.contributes?.agentExtensions || [])])) {
      if (fs.existsSync(path.join(srcPlugin, f))) {
        await fsp.copyFile(path.join(srcPlugin, f), path.join(destPlugin, f));
      }
    }
    for (const f of fs.readdirSync(srcCore).filter(name => name.endsWith('.js'))) {
      await fsp.copyFile(path.join(srcCore, f), path.join(destCore, f));
    }
    return [{ filePath: destPlugin, action: 'installed-plugin' }];
  }

  if (agentId === 'dsh') {
    return [{ filePath: path.join(homeDir, '.memory'), action: 'shared-store-compatible' }];
  }

  throw new Error(`Unknown agent: ${agentId}`);
}

async function uninstallFromHome(homeDir = os.homedir(), env = process.env) {
  const restored = [];
  const claudeSettings = path.join(homeDir, '.claude', 'settings.json');
  if (await unpatchJsonFile(claudeSettings, removeMemhubHooks)) restored.push(claudeSettings);
  for (const mcpFile of [
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.cursor', 'mcp.json'),
    path.join(homeDir, '.pi', 'agent', 'mcp.json'),
  ]) {
    if (await unpatchJsonFile(mcpFile, removeMcpServer)) restored.push(mcpFile);
  }
  const codexDir = codexHome(homeDir, env);
  const codexHooks = path.join(codexDir, 'hooks.json');
  if (await unpatchJsonFile(codexHooks, removeMemhubHooks)) {
    if (!Object.keys(await readJson(codexHooks)).length) await fsp.rm(codexHooks, { force: true });
    restored.push(codexHooks);
  }
  const codexToml = path.join(codexDir, 'config.toml');
  if (fs.existsSync(codexToml)) {
    const raw = await fsp.readFile(codexToml, 'utf8');
    if (raw.includes(CODEX_START)) {
      const next = stripCodexBlock(raw).trim();
      await writeAtomic(codexToml, next ? `${next}\n` : '');
      restored.push(codexToml);
    }
  }
  const piPlugin = path.join(homeDir, '.pi-desktop', 'plugins', 'installed', 'memhub.universal-memory');
  if (fs.existsSync(piPlugin)) {
    await fsp.rm(piPlugin, { recursive: true, force: true });
    restored.push(piPlugin);
  }
  return restored;
}

module.exports = {
  detectAgents,
  installForAgent,
  uninstallFromHome,
};
