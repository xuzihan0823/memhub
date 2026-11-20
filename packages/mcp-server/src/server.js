'use strict';

const core = require('../../core/src');

const TOOL_NAMES = { load: 'memory_load', search: 'memory_search', propose: 'memory_propose', forget: 'memory_forget' };

const PROPOSE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'State the conclusion itself, e.g. "生产镜像必须指定 linux/amd64".' },
    summary: { type: 'string', description: 'One line: when / under which conditions it applies.' },
    content: { type: 'string', description: 'Full text. Handoffs: 目标 / 当前进度 / 验收标准 / 下一步 / 阻塞 / 相关文件. Record stage-only updates too; mark missing details 未提供, do not invent them.' },
    keywords: { type: 'array', items: { type: 'string' } },
    triggers: { type: 'array', items: { type: 'string' }, description: 'Situations and synonyms that should recall this memory (e.g. 上线, 部署, docker build).' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Project-relative globs for retrieval only; use cwd to choose the destination project.' },
    scope: {
      type: 'string',
      enum: ['global', 'project', 'handoff'],
      description: 'global: durable knowledge valid across projects. project: durable knowledge for the target repo. handoff: changing project stage, latest progress, TODOs or task state.',
    },
    type: { type: 'string', enum: ['user', 'pref', 'skill', 'decision', 'project', 'note', 'handoff'] },
    salience: { type: 'integer', minimum: 1, maximum: 3, description: '1 = always relevant, 3 = rarely.' },
    task: { type: 'string', description: 'Handoff only: use project-status for the project current stage, or a distinct fixed key per concrete task. Same key updates in place.' },
    status: { type: 'string', enum: ['active', 'blocked', 'done', 'abandoned'], description: 'Handoff only. done requires every acceptance item checked with evidence.' },
    ttl_days: { type: 'integer', minimum: 1, description: 'Handoff only: expire after N days without update (default 14).' },
    supersedes: { type: 'array', items: { type: 'string' }, description: 'Long-term only: IDs or 6-char short refs of different-title entries that this new entry replaces and deprecates.' },
  },
  required: ['title', 'content'],
};

const TOOLS = [
  {
    name: 'memory_boot',
    description: 'Load persona (SOUL.md), memory protocol, active handoffs for the current directory, and the catalog of all long-term memory headers. Hosts with hooks inject this automatically at session start.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Current workspace path (optional).' },
        origin_agent: { type: 'string' },
        source_session_id: { type: 'string' },
      },
    },
  },
  {
    name: 'memory_search',
    description: 'Search global and project memories by query, or list one category by passing type (or scope) without query. Returns IDs, scopes, titles, and one-line summaries (no bodies).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        cwd: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'project', 'handoff'] },
        type: { type: 'string', enum: ['user', 'pref', 'skill', 'decision', 'project', 'note', 'spec'], description: 'Filter by memory type; without query it lists that category.' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: 'memory_load',
    description: 'Load full Markdown content of one memory entry by ID or the short ref shown in the catalog, and update last_access.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_propose',
    description: 'Pass an items array to save durable memory or update a handoff. Current project stage, latest progress, TODOs and PR state belong in scope="handoff", task="project-status", not global long-term memory. Set cwd to the verified target project even when this session is in another workspace; use separate calls for different projects. Long-term: only durable lessons grounded in user messages or tool output; never infer user traits or save setup failures, transient errors or unverified attempts. Same title supersedes old conclusions; same task updates handoffs in place; done/abandoned archives them. Commits directly unless requireReview is true.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Verified target project root, including another workspace. Defaults to the session directory. paths does not select the store.' },
        agent: { type: 'string' },
        requireReview: { type: 'boolean', description: 'Optional: queue to inbox instead of committing immediately.' },
        items: { type: 'array', minItems: 1, maxItems: 5, items: PROPOSE_ITEM_SCHEMA },
      },
      required: ['items'],
    },
  },
  {
    name: 'memory_forget',
    description: 'Deprecate or archive an existing memory entry autonomously, or physically delete with confirm=true after explicit user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        cwd: { type: 'string' },
        mode: { type: 'string', enum: ['deprecate', 'archive', 'delete'] },
        reason: { type: 'string' },
        confirm: { type: 'boolean', description: 'Required true only for irreversible mode="delete".' },
      },
      required: ['id'],
    },
  },
  ...core.SESSION_TOOLS,
];

async function handleToolCall(name, args = {}, defaults = {}) {
  const stores = core.resolveStores({
    homeDir: defaults.homeDir,
    globalDir: defaults.globalDir,
    cwd: args.cwd || defaults.cwd || process.cwd(),
  });

  if (name.startsWith('memory_session_')) {
    return { content: [{ type: 'text', text: JSON.stringify(await core.handleSessionTool(name, stores, args), null, 2) }] };
  }

  if (name === 'memory_boot') {
    await core.scaffoldGlobalStore(stores.globalDir);
    const session = args.source_session_id ? { origin_agent: args.origin_agent || 'mcp-client', source_session_id: args.source_session_id } : undefined;
    const boot = await core.bootContext(stores, { tools: TOOL_NAMES, session });
    return { content: [{ type: 'text', text: core.renderBootBlock(boot) }] };
  }

  if (name === 'memory_search') {
    const entries = await core.loadAllEntries(stores);
    const hits = core.searchEntries(entries, String(args.query || ''), {
      scope: args.scope,
      type: args.type,
      limit: Number.isInteger(args.limit) ? args.limit : 8,
    });
    const out = hits.map(h => ({
      id: h.entry.id,
      scope: h.entry.scope,
      type: h.entry.type,
      title: h.entry.title,
      summary: h.entry.summary,
      score: h.score,
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ hits: out }, null, 2) }] };
  }

  if (name === 'memory_load') {
    const entry = await core.loadEntryById(stores, String(args.id || ''), { touchAccess: true });
    if (!entry) {
      return { isError: true, content: [{ type: 'text', text: `Memory entry not found: ${args.id}` }] };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: entry.id,
          scope: entry.scope,
          title: entry.title,
          status: entry.status,
          related: entry.related,
          supersededBy: entry.supersededBy,
          content: entry.body,
        }, null, 2),
      }],
    };
  }

  if (name === 'memory_propose') {
    const res = await core.proposeMemory(stores, {
      items: args.items,
      agent: args.agent || 'mcp-client',
      requireReview: Boolean(args.requireReview),
    });
    return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
  }

  if (name === 'memory_forget') {
    const res = await core.forgetEntry(stores, {
      id: String(args.id || ''),
      mode: args.mode || 'deprecate',
      reason: args.reason || '',
      confirm: Boolean(args.confirm),
    });
    return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function processRpcMessage(msg, defaults = {}) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;

  if (method === 'notifications/initialized' || id === undefined) {
    return null;
  }

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'memhub', version: '0.1.0' },
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }

    if (method === 'tools/call') {
      const result = await handleToolCall(params?.name, params?.arguments || {}, defaults);
      return { jsonrpc: '2.0', id, result };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: err?.message || String(err) },
    };
  }
}

function startStdioMcpServer(defaults = {}) {
  let buffer = '';
  const writeMsg = obj => {
    if (!obj) return;
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Content-Length:')) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      processRpcMessage(parsed, defaults).then(writeMsg).catch(() => {});
    }
  });
}

module.exports = {
  TOOLS,
  TOOL_NAMES,
  PROPOSE_ITEM_SCHEMA,
  handleToolCall,
  processRpcMessage,
  startStdioMcpServer,
};
