'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const core = require('../../core/src');

const MAX_SEEN = 200;
const MAX_TOOL_INJECTIONS_PER_TURN = 3;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NO_OUTPUT = '{}';

function cacheFileFor({ cacheDir, cwd, sessionId }) {
  if (!sessionId) return null;
  const key = crypto.createHash('sha1').update(`${cwd}\0${sessionId}`).digest('hex');
  return path.join(cacheDir, `${key}.json`);
}

function readState(file) {
  const empty = { ids: [], dirs: [], turn: 0, turnsSinceSelfCheck: 0, compactPending: false, toolInjections: 0, wrote: false, handoffTouched: false };
  if (!file || !fs.existsSync(file)) return empty;
  try {
    return { ...empty, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return empty;
  }
}

function writeState(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, ids: state.ids.slice(-MAX_SEEN), dirs: state.dirs.slice(-MAX_SEEN), updatedAt: Date.now() }));
    fs.renameSync(tmp, file);
  } catch {
    // non-fatal
  }
}

function lastAssistantText(transcriptPath, maxBytes = 64 * 1024) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return '';
  try {
    const st = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').split('\n').reverse();
      for (const line of lines) {
        if (!line.includes('"assistant"')) continue;
        try {
          const rec = JSON.parse(line);
          const content = rec?.message?.content;
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '';
          if (rec?.message?.role === 'assistant' && text.trim()) return text.trim();
        } catch {
          // partial line
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // unreadable transcript
  }
  return '';
}

function toolFilePath(toolInput, cwd) {
  const raw = toolInput?.file_path || toolInput?.notebook_path || toolInput?.path;
  if (typeof raw !== 'string' || !raw) return null;
  const abs = path.resolve(cwd, raw);
  return abs;
}

function relativeToProject(absPath, stores) {
  const base = stores.projectRoot || stores.cwd;
  if (!absPath || !base) return null;
  const rel = path.relative(base, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function contextOutput(eventName, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
}

async function runHook({ event, payload = {}, flags = {}, homeDir, globalDir, cacheDir, fetchImpl } = {}) {
  const cwd = payload.cwd || flags.cwd || process.cwd();
  const stores = core.resolveStores({ cwd, homeDir, globalDir });
  const sessionId = String(payload.session_id || payload.sessionId || '');
  const file = cacheFileFor({ cacheDir: cacheDir || path.join(homeDir || os.homedir(), '.cache', 'memhub', 'sessions'), cwd, sessionId });
  const state = readState(file);

  if (event === 'PreCompact') {
    state.compactPending = true;
    writeState(file, state);
    return NO_OUTPUT;
  }

  if (event === 'SessionStart') {
    const source = String(payload.source || 'startup');
    const fresh = { ids: [], dirs: [], turn: 0, turnsSinceSelfCheck: 0, compactPending: source === 'compact', toolInjections: 0, wrote: false, handoffTouched: false };
    await core.scaffoldGlobalStore(stores.globalDir);
    const boot = await core.bootContext(stores);
    writeState(file, source === 'resume' ? { ...state, toolInjections: 0 } : fresh);
    return contextOutput('SessionStart', core.renderBootBlock(boot));
  }

  if (event === 'UserPromptSubmit') {
    const prompt = String(payload.prompt || payload.user_prompt || '').trim();
    state.turn += 1;
    state.turnsSinceSelfCheck += 1;
    state.toolInjections = 0;
    state.wrote = false;
    state.handoffTouched = false;
    if (prompt.length < 2) {
      writeState(file, state);
      return NO_OUTPUT;
    }
    const result = await core.retrieveContext(stores, {
      query: prompt,
      previousContext: lastAssistantText(payload.transcript_path),
      exclude: state.ids,
      fetchImpl,
    });
    state.ids.push(...result.ids);
    writeState(file, state);
    return result.block ? contextOutput('UserPromptSubmit', result.block) : NO_OUTPUT;
  }

  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const toolName = String(payload.tool_name || '');
    const toolInput = payload.tool_input || {};
    const failed = event === 'PostToolUseFailure';
    if (/memory_propose$|_propose$/.test(toolName) && !failed) {
      state.turnsSinceSelfCheck = 0;
      if (JSON.stringify(toolInput).includes('handoff')) state.handoffTouched = true;
    }
    if (EDIT_TOOLS.has(toolName) && !failed) state.wrote = true;

    const absFile = toolFilePath(toolInput, cwd);
    const relFile = relativeToProject(absFile, stores);
    const dir = relFile ? path.posix.dirname(relFile) : null;
    const newDir = dir !== null && !state.dirs.includes(dir);
    if (newDir) state.dirs.push(dir);

    if ((!failed && !newDir) || state.toolInjections >= MAX_TOOL_INJECTIONS_PER_TURN) {
      writeState(file, state);
      return NO_OUTPUT;
    }
    const query = failed
      ? `${toolName} ${typeof toolInput.command === 'string' ? toolInput.command.slice(0, 300) : ''} ${String(payload.error || '').slice(0, 800)}`
      : '';
    const result = await core.retrieveContext(stores, {
      query,
      paths: relFile ? [relFile] : [],
      exclude: state.ids,
      limit: 3,
      fetchImpl,
    });
    if (result.block) {
      state.ids.push(...result.ids);
      state.toolInjections += 1;
    }
    writeState(file, state);
    return result.block ? contextOutput(event, result.block) : NO_OUTPUT;
  }

  if (event === 'Stop') {
    const notes = [];
    const pending = await core.listInboxBatches(stores);
    if (pending.length) notes.push(`MemHub 提示：当前有 ${pending.length} 条待审批记忆提案，可运行 memhub ui 处理。`);
    const handoffHint = state.wrote && !state.handoffTouched;
    const cfg = core.selfCheckConfig(stores);
    const due = !payload.stop_hook_active && cfg.enabled && (handoffHint || state.compactPending || state.turnsSinceSelfCheck >= cfg.everyTurns);
    writeState(file, { ...state, wrote: false, ...(due ? { turnsSinceSelfCheck: 0, compactPending: false } : {}) });
    if (due) {
      const hint = handoffHint ? '\n本轮修改了文件但还没有更新任务交接单；任务未完成时请先提交 scope="handoff" 交接单。' : '';
      return JSON.stringify({ decision: 'block', reason: `${core.selfCheckPrompt()}${hint}`, ...(notes.length ? { systemMessage: notes.join('\n') } : {}) });
    }
    return notes.length ? JSON.stringify({ systemMessage: notes.join('\n') }) : NO_OUTPUT;
  }

  return NO_OUTPUT;
}

module.exports = { runHook, lastAssistantText };
