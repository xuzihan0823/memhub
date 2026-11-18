'use strict';

const INACTIVE_STATUSES = new Set(['deprecated', 'superseded', 'archived', 'retired', 'done', 'abandoned', 'expired']);
const HANDOFF_STATUSES = ['active', 'blocked', 'done', 'abandoned'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function todayStr(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function daysSince(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  const then = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(Date.parse(dateStr));
  if (!Number.isFinite(then.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today - then) / (24 * 60 * 60 * 1000));
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function asList(value) {
  if (Array.isArray(value)) return value.map(x => String(x).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(x => x.trim()).filter(Boolean);
  return [];
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sanitizeInline(text, max = 140) {
  return clip(String(text ?? '').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim(), max);
}

function yamlScalar(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(x => String(x).trim()).filter(Boolean);
    } catch {
      // fall back to loose YAML flow list
    }
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  if (/^"[\s\S]*"$/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
  }
  return trimmed.replace(/^'([\s\S]*)'$/, '$1');
}

function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  const data = {};
  let listKey = null;
  for (const line of match[1].split('\n')) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (pair) {
      listKey = pair[1];
      data[listKey] = pair[2] ? yamlScalar(pair[2]) : [];
    } else if (listKey && /^\s+-\s+/.test(line)) {
      if (!Array.isArray(data[listKey])) data[listKey] = [];
      const item = yamlScalar(line.replace(/^\s+-\s+/, ''));
      if (item !== null && item !== '') data[listKey].push(item);
    }
  }
  return { data, body: text.slice(match[0].length).trim() };
}

function formatYamlValue(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    return `[${val.map(v => JSON.stringify(String(v))).join(', ')}]`;
  }
  return JSON.stringify(String(val));
}

function serializeEntry(meta, body) {
  const orderedKeys = [
    'id', 'scope', 'type', 'title', 'summary', 'keywords', 'triggers', 'paths',
    'salience', 'status', 'task', 'cwd', 'supersededBy', 'related',
    'origin_agent', 'created_at', 'updated_at', 'last_access', 'ttl_days',
  ];
  const lines = ['---'];
  const seen = new Set();
  for (const key of orderedKeys) {
    if (meta[key] === undefined) continue;
    seen.add(key);
    if (key === 'related' && Array.isArray(meta[key]) && meta[key].length > 0) {
      lines.push(`${key}:`);
      for (const item of meta[key]) lines.push(`  - ${formatYamlValue(item)}`);
    } else {
      lines.push(`${key}: ${formatYamlValue(meta[key])}`);
    }
  }
  for (const [key, val] of Object.entries(meta)) {
    if (seen.has(key) || val === undefined) continue;
    lines.push(`${key}: ${formatYamlValue(val)}`);
  }
  lines.push('---', '', String(body ?? '').trim(), '');
  return lines.join('\n');
}

function firstMeaningfulLine(body) {
  for (const line of String(body ?? '').split('\n')) {
    const clean = line.replace(/^#+\s*/, '').replace(/^[-*>]\s+/, '').trim();
    if (clean && !/^[-=`]{3,}$/.test(clean)) return clean;
  }
  return '';
}

function basenameNoExt(relPath) {
  return String(relPath).split('/').pop().replace(/\.md$/i, '');
}

function textField(value) {
  return ['string', 'number', 'boolean'].includes(typeof value) ? String(value).trim() : '';
}

function parseEntry(relPath, raw, { scope, rootDir, readOnly = false }) {
  const { data, body } = parseFrontmatter(raw);
  const title = textField(data.title) || basenameNoExt(relPath);
  const id = textField(data.id) || `${scope}:${basenameNoExt(relPath)}`;
  const summary = clip(String(data.summary || data.description || firstMeaningfulLine(body) || title), 120);
  const salienceNum = Number(data.salience);
  const salience = [1, 2, 3].includes(salienceNum) ? salienceNum : 2;
  const ttlNum = Number(data.ttl_days);
  const ttl_days = Number.isFinite(ttlNum) && ttlNum > 0 ? ttlNum : null;

  return {
    id,
    scope: typeof data.scope === 'string' && data.scope.trim() ? data.scope.trim() : scope,
    type: typeof data.type === 'string' && data.type.trim() ? data.type.trim() : (relPath.startsWith('handoffs/') ? 'handoff' : 'note'),
    title,
    summary,
    keywords: asList(data.keywords ?? data.tags),
    triggers: asList(data.triggers),
    paths: asList(data.paths),
    salience,
    status: normalizeText(data.status) || 'active',
    task: typeof data.task === 'string' && data.task.trim() ? data.task.trim() : null,
    cwd: typeof data.cwd === 'string' && data.cwd.trim() ? data.cwd.trim() : null,
    supersededBy: typeof data.supersededBy === 'string' && data.supersededBy.trim() ? data.supersededBy.trim() : null,
    related: asList(data.related),
    origin_agent: typeof data.origin_agent === 'string' ? data.origin_agent : null,
    created_at: typeof data.created_at === 'string' ? data.created_at : (typeof data.date === 'string' ? data.date : null),
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
    last_access: typeof data.last_access === 'string' ? data.last_access : null,
    ttl_days,
    relPath,
    rootDir,
    readOnly,
    body,
    rawMeta: data,
  };
}

function parseSpecFile(relPath, raw, { scope, rootDir }) {
  const entries = [];
  for (const match of String(raw ?? '').matchAll(/<spec-entry\b([^>]*)>([\s\S]*?)<\/spec-entry>/g)) {
    const attrs = {};
    for (const a of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs[a[1]] = a[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    if (!attrs.sid) continue;
    const body = match[2].trim();
    entries.push({
      id: attrs.sid,
      scope,
      type: 'spec',
      title: attrs.title || attrs.sid,
      summary: clip(attrs.description || firstMeaningfulLine(body) || attrs.title || attrs.sid, 120),
      keywords: asList(attrs.keywords),
      triggers: [],
      paths: [],
      salience: 1,
      status: normalizeText(attrs.status) || 'active',
      task: null,
      cwd: null,
      supersededBy: attrs.supersededBy || attrs['superseded-by'] || null,
      related: asList(attrs.ref),
      origin_agent: 'spec',
      created_at: null,
      updated_at: null,
      last_access: null,
      ttl_days: null,
      relPath,
      rootDir,
      readOnly: true,
      body,
      rawMeta: attrs,
    });
  }
  return entries;
}

function isHandoffExpired(entry, now = new Date()) {
  if (entry.scope !== 'handoff' || !entry.ttl_days) return false;
  const age = daysSince(entry.updated_at || entry.created_at, now);
  return age !== null && age > entry.ttl_days;
}

function isActiveEntry(entry) {
  return !INACTIVE_STATUSES.has(entry.status) && !entry.supersededBy && !isHandoffExpired(entry);
}

function extractRelativeLinks(body) {
  const links = [];
  for (const match of String(body ?? '').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].trim();
    if (!target || /^(https?:|mailto:|#)/i.test(target)) continue;
    links.push(target.split('#')[0]);
  }
  return [...new Set(links)];
}

module.exports = {
  INACTIVE_STATUSES,
  HANDOFF_STATUSES,
  todayStr,
  daysSince,
  normalizeText,
  asList,
  clip,
  sanitizeInline,
  parseFrontmatter,
  serializeEntry,
  parseEntry,
  parseSpecFile,
  isActiveEntry,
  isHandoffExpired,
  extractRelativeLinks,
};
