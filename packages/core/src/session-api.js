'use strict';

const sessions = require('./sessions');
const identity = {
  origin_agent: { type: 'string' }, source_session_id: { type: 'string' },
  parent_session_key: { type: 'string' }, is_subagent: { type: 'boolean' },
};
const definitions = [
  ['capture', 'Save standardized dialogue separately from long-term memory. Supply stable message_key values; repeated full transcripts are deduplicated. Never submit hidden reasoning.', {
    ...identity, collection_gap: { type: 'string' }, messages: { type: 'array', items: { type: 'object', properties: {
      message_key: { type: 'string' }, turn_id: { type: 'string' }, role: { type: 'string', enum: ['user', 'assistant', 'tool'] }, created_at: { type: 'string' }, text: { type: 'string' },
    }, required: ['message_key', 'role', 'text'] } },
  }, ['origin_agent', 'source_session_id', 'messages']],
  ['restore', 'Restore the previous main session in this workspace, regardless of agent. Pin its source to this host session.', { ...identity, max_chars: { type: 'integer', minimum: 500 } }, ['origin_agent', 'source_session_id']],
  ['list', 'List saved conversation sources. Defaults to this workspace; explicitly enable cross_workspace for other projects. Does not search long-term knowledge.', {
    cross_workspace: { type: 'boolean' }, origin_agent: { type: 'string' }, include_subagents: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 200 },
  }, []],
  ['load', 'Read saved original messages by sequence range. Summary is not a verbatim quote. Use workspace_root from session_list to read another workspace.', {
    session_key: { type: 'string' }, workspace_root: { type: 'string' }, from_seq: { type: 'integer', minimum: 1 }, to_seq: { type: 'integer', minimum: 1 },
  }, ['session_key']],
  ['status', 'Inspect saved sequence, summary coverage, restoration sources and location-index state without dialogue bodies. Host hook trust must be checked in the host.', {}, []],
];
const SESSION_TOOLS = definitions.map(([action, description, properties, required]) => ({
  name: `memory_session_${action}`, description,
  inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, ...properties }, required },
}));
const handlers = { capture: sessions.captureSession, restore: sessions.restoreSessionContext, list: sessions.listSessions, load: sessions.loadSession, status: sessions.sessionDiagnostics };
async function handleSessionTool(name, stores, args) {
  const handler = handlers[name.replace(/^(memory_)?session_/, '')];
  if (!handler) throw new Error('Unknown session operation');
  return handler(stores, args);
}
module.exports = { SESSION_TOOLS, handleSessionTool };
