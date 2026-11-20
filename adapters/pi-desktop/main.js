'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE = 'http://127.0.0.1:4789';
const AGENT = 'pi-desktop';

function loadLocalCore() {
  for (const rel of ['./core/0.3.6/src', '../../packages/core/src']) {
    const candidate = path.resolve(__dirname, rel, 'index.js');
    if (fs.existsSync(candidate)) {
      try { return require(candidate); } catch {}
    }
  }
  return null;
}

const core = loadLocalCore();

async function resolveCwd(ctx, targetCwd, { requireProject = true } = {}) {
  if (targetCwd !== undefined) {
    if (typeof targetCwd !== 'string' || !path.isAbsolute(targetCwd) || !fs.existsSync(targetCwd) || !fs.statSync(targetCwd).isDirectory()) {
      throw new Error('cwd must be an absolute path to an existing project directory');
    }
    if (requireProject && core && !core.resolveStores({ cwd: targetCwd }).projectDir) {
      throw new Error('cwd does not identify a project; verify the target directory before writing project progress');
    }
    return targetCwd;
  }
  if (typeof ctx?.cwd === 'string' && ctx.cwd) return ctx.cwd;
  try {
    const workspace = await pi.workspace.get();
    if (workspace?.path) return workspace.path;
  } catch {}
  return undefined;
}

async function callDaemon(route, { method = 'GET', body } = {}) {
  const res = await pi.net.fetch({
    url: `${DEFAULT_BASE}${route}`,
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    timeoutMs: 5000,
  });
  if (res.status < 200 || res.status >= 300) {
    let message = `MemHub daemon HTTP ${res.status}`;
    try { message = JSON.parse(res.bodyText).error || message; } catch {}
    throw new Error(message);
  }
  return JSON.parse(res.bodyText || '{}');
}

const clampLimit = value => (Number.isInteger(value) ? Math.min(Math.max(value, 1), 20) : 8);

const tools = {
  search: async (args, ctx) => {
    const cwd = await resolveCwd(ctx, args?.cwd);
    const query = String(args?.query || '');
    if (core) {
      const entries = await core.loadAllEntries(core.resolveStores({ cwd }));
      const hits = core.searchEntries(entries, query, { scope: args?.scope, type: args?.type, limit: clampLimit(args?.limit) });
      return { query, hits: hits.map(h => ({ id: h.entry.id, scope: h.entry.scope, type: h.entry.type, title: h.entry.title, summary: h.entry.summary, score: h.score })) };
    }
    const qs = new URLSearchParams({ q: query });
    if (cwd) qs.set('cwd', cwd);
    if (args?.scope) qs.set('scope', args.scope);
    if (args?.type) qs.set('type', args.type);
    if (args?.limit) qs.set('limit', String(args.limit));
    return callDaemon(`/api/search?${qs}`);
  },
  load: async (args, ctx) => {
    const cwd = await resolveCwd(ctx, args?.cwd);
    const id = String(args?.id || '');
    if (core) {
      const entry = await core.loadEntryById(core.resolveStores({ cwd }), id, { touchAccess: true });
      if (!entry) throw new Error(`Memory entry not found: ${id}`);
      return { id: entry.id, scope: entry.scope, type: entry.type, title: entry.title, status: entry.status, task: entry.task, related: entry.related, supersededBy: entry.supersededBy, content: entry.body };
    }
    const qs = new URLSearchParams({ id });
    if (cwd) qs.set('cwd', cwd);
    return callDaemon(`/api/load?${qs}`);
  },
  propose: async (args, ctx) => {
    const cwd = await resolveCwd(ctx, args?.cwd);
    const sessionId = ctx?.sessionId || null;
    if (core) {
      return core.proposeMemory(core.resolveStores({ cwd }), { items: args?.items, agent: AGENT, sessionId, requireReview: Boolean(args?.requireReview) });
    }
    return callDaemon('/api/propose', { method: 'POST', body: { cwd, agent: AGENT, sessionId, items: args?.items, requireReview: Boolean(args?.requireReview) } });
  },
  forget: async (args, ctx) => {
    const cwd = await resolveCwd(ctx, args?.cwd);
    const params = { id: String(args?.id || ''), mode: args?.mode || 'deprecate', reason: args?.reason || '', confirm: Boolean(args?.confirm) };
    if (core) return core.forgetEntry(core.resolveStores({ cwd }), params);
    return callDaemon('/api/forget', { method: 'POST', body: { cwd, ...params } });
  },
};

if (core) {
  for (const definition of core.SESSION_TOOLS) {
    const name = definition.name.replace(/^memory_/, '');
    tools[name] = async (args, ctx) => {
      const cwd = await resolveCwd(ctx, args?.cwd, { requireProject: false });
      if (!cwd) throw new Error('Current workspace is unavailable; pass cwd explicitly to the session tool');
      return core.handleSessionTool(name, core.resolveStores({ cwd }), args || {});
    };
  }
}

const registered = [];

async function onLoad() {
  for (const [name, execute] of Object.entries(tools)) {
    await pi.agent.registerTool({ name, execute });
    registered.push(name);
  }
}

async function onUnload() {
  while (registered.length) {
    const name = registered.pop();
    try { await pi.agent.unregisterTool?.(name); } catch {}
  }
}

module.exports = { onLoad, onUnload, activate: onLoad, deactivate: onUnload, _internals: { tools } };
