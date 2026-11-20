'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { safeReadText, atomicWriteText, withStoreTransaction } = require('./fs-safe');
const { isActiveEntry } = require('./markdown');

const IGNORE_ALL = '*\n!.gitignore\n';

const ENTITY_STOP = new Set([
  'the', 'this', 'that', 'with', 'from', 'for', 'and', 'not', 'are', 'was', 'were', 'will',
  'have', 'has', 'had', 'can', 'use', 'used', 'using', 'when', 'where', 'what', 'how', 'why',
  'note', 'true', 'false', 'null', 'http', 'https', 'example', 'com', 'global', 'project',
  'skill', 'decision', 'user', 'active', 'agent', 'agents', 'desktop', 'app', 'api', 'cli',
  'readme', 'users', 'library', 'local', 'localhost', '127.0.0.1', '0.0.0.0', 'todo', 'done',
  'blocked', 'md', 'js', 'ts', 'json', 'utf8', 'stdio', 'mac', 'macos', 'node', 'npm', 'git',
  'main', 'src', 'packages', 'core', 'docs', 'tests', 'build', 'dist', 'tmp', 'var', 'home',
  'path', 'let', 'put', 'esc', 'teams', 'operation', 'distribution', 'github', 'error', 'info',
  'warn', 'warning', 'check', 'test', 'tests', 'file', 'files', 'data', 'config', 'default',
]);

function extractEntities(text, extra = []) {
  const out = new Set();
  const clean = String(text ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  for (const m of clean.matchAll(/`([^`\n]{3,40})`/g)) {
    const v = m[1].trim().toLowerCase();
    if (!/[{}\s=]/.test(v) && !ENTITY_STOP.has(v) && !/^\d+$/.test(v) && !v.endsWith('.md')) out.add(v);
  }
  for (const m of clean.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
    if (!ENTITY_STOP.has(m[0])) out.add(m[0]);
  }
  for (const m of clean.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+){1,3}\b/gi)) {
    const v = m[0].toLowerCase();
    if (!/^\d+(?:\.\d+)+$/.test(v) && !ENTITY_STOP.has(v) && v.length >= 4 && !/\.(md|js|ts|json|txt)$/i.test(v)) {
      out.add(v);
    }
  }
  for (const m of clean.matchAll(/\b[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+\b/g)) {
    const v = m[0].toLowerCase();
    if (v.length >= 4 && !ENTITY_STOP.has(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) out.add(v);
  }
  for (const m of clean.matchAll(/\b[A-Z][A-Za-z0-9]{2,}\b/g)) {
    const raw = m[0];
    const v = raw.toLowerCase();
    const mixedOrCaps = /[A-Z]/.test(raw.slice(1));
    if (!ENTITY_STOP.has(v) && (mixedOrCaps || raw.length >= 4)) out.add(v);
  }
  for (const item of extra || []) {
    const v = String(item ?? '').trim().toLowerCase();
    if (v.length >= 2 && !ENTITY_STOP.has(v)) out.add(v);
  }
  return [...out];
}

function buildEntityIndex(entries) {
  const active = (entries || [])
    .filter(e => isActiveEntry(e) && e.scope !== 'handoff')
    .sort((a, b) => a.id.localeCompare(b.id));
  const sig = active.map(e => `${e.id}:${e.updated_at || e.created_at || ''}:${e.title}`).join('\n');
  const entriesHash = crypto.createHash('sha1').update(sig).digest('hex');

  const entities = {};
  const byId = {};
  for (const e of active) {
    const list = extractEntities(`${e.title}\n${e.summary}\n${e.body}`, [...(e.keywords || []), ...(e.triggers || [])]);
    byId[e.id] = list;
    for (const ent of list) {
      if (!entities[ent]) entities[ent] = [];
      entities[ent].push(e.id);
    }
  }
  return { version: 1, entriesHash, entities, byId };
}

async function syncEntityIndex(stores, entries) {
  const index = buildEntityIndex(entries);
  const stateRoot = path.join(stores.globalDir, 'state');
  try {
    const raw = await safeReadText(stateRoot, 'entities.json');
    const cached = JSON.parse(raw);
    if (cached && cached.version === 1 && cached.entriesHash === index.entriesHash) return cached;
  } catch {
    // rebuild below
  }
  try {
    await withStoreTransaction(stateRoot, async () => {
      let ignore = '';
      try { ignore = await safeReadText(stateRoot, '.gitignore'); } catch {}
      if (ignore !== IGNORE_ALL) await atomicWriteText(stateRoot, '.gitignore', IGNORE_ALL);
      let current = null;
      try { current = JSON.parse(await safeReadText(stateRoot, 'entities.json')); } catch {}
      if (current?.entriesHash === index.entriesHash) return;
      await atomicWriteText(stateRoot, 'entities.json', JSON.stringify(index, null, 2) + '\n');
    });
  } catch {
    // entity index persistence is non-fatal
  }
  return index;
}

function entityLinkExpansion(entries, directHits, query, index, { exclude, maxLinked = 2 } = {}) {
  const active = (entries || []).filter(e => isActiveEntry(e) && e.scope !== 'handoff');
  if (!active.length || maxLinked <= 0) return [];

  const directIds = new Set((directHits || []).map(h => h.entry.id));
  const skip = new Set([...(exclude || []), ...directIds]);
  const maxShare = Math.max(6, Math.floor(active.length * 0.35));

  const seedWeights = new Map();
  for (const ent of extractEntities(query)) {
    seedWeights.set(ent, Math.max(seedWeights.get(ent) || 0, 1.0));
  }
  for (const hit of (directHits || []).slice(0, 3)) {
    for (const ent of index.byId[hit.entry.id] || []) {
      seedWeights.set(ent, Math.max(seedWeights.get(ent) || 0, 0.8));
    }
  }
  if (!seedWeights.size) return [];

  const candidates = new Map();
  for (const [ent, seedWeight] of seedWeights) {
    const linked = index.entities[ent];
    if (!linked || linked.length < 2 || linked.length > maxShare) continue;
    const damp = 1 / (1 + 0.05 * ((linked.length - 1) ** 2));
    const gain = seedWeight * damp;
    for (const id of linked) {
      if (skip.has(id)) continue;
      if (!candidates.has(id)) candidates.set(id, { score: 0, via: [] });
      const rec = candidates.get(id);
      rec.score += gain;
      rec.via.push({ ent, gain });
    }
  }
  if (!candidates.size) return [];

  const byId = new Map(active.map(e => [e.id, e]));
  return [...candidates.entries()]
    .filter(([id]) => byId.has(id))
    .map(([id, rec]) => {
      const entry = byId.get(id);
      const via = rec.via.sort((a, b) => b.gain - a.gain).slice(0, 2).map(v => v.ent);
      return { entry, via, score: Number(rec.score.toFixed(3)) };
    })
    .sort((a, b) =>
      b.score - a.score
      || a.entry.salience - b.entry.salience
      || String(b.entry.updated_at || b.entry.created_at || '').localeCompare(String(a.entry.updated_at || a.entry.created_at || ''))
      || a.entry.id.localeCompare(b.entry.id)
    )
    .slice(0, maxLinked);
}

module.exports = {
  extractEntities,
  buildEntityIndex,
  syncEntityIndex,
  entityLinkExpansion,
};
