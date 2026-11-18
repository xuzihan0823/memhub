'use strict';

const path = require('node:path');
const { safeReadText, atomicWriteText, withStoreTransaction } = require('./fs-safe');
const { daysSince } = require('./markdown');

const DORMANT_DAYS = 90;
const REVIEW_DAYS = 180;
const IGNORE_ALL = '*\n!.gitignore\n';

const usageRoot = stores => path.join(stores.globalDir, 'state');

async function readUsage(stores) {
  try {
    const data = JSON.parse(await safeReadText(usageRoot(stores), 'usage.json'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

async function recordUsage(stores, ids, kind) {
  const unique = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!unique.length) return;
  const root = usageRoot(stores);
  try {
    await withStoreTransaction(root, async () => {
      let ignore = '';
      try { ignore = await safeReadText(root, '.gitignore'); } catch {}
      if (ignore !== IGNORE_ALL) await atomicWriteText(root, '.gitignore', IGNORE_ALL);
      const usage = await readUsage(stores);
      const now = new Date().toISOString();
      const field = kind === 'load' ? 'loads' : 'injections';
      for (const id of unique) {
        const row = usage[id] && typeof usage[id] === 'object' ? usage[id] : {};
        usage[id] = { ...row, last_used: now, [field]: (Number(row[field]) || 0) + 1 };
      }
      await atomicWriteText(root, 'usage.json', JSON.stringify(usage, null, 2) + '\n');
    });
  } catch {
    // usage tracking must never block retrieval
  }
}

function lastUsedAt(entry, usage = {}) {
  return [usage[entry.id]?.last_used, entry.last_access, entry.updated_at, entry.created_at]
    .filter(v => typeof v === 'string' && v)
    .map(v => v.slice(0, 10))
    .sort()
    .at(-1) || null;
}

function idleDays(entry, usage, now) {
  return daysSince(lastUsedAt(entry, usage), now);
}

function isDormant(entry, usage, { days = DORMANT_DAYS, now = new Date() } = {}) {
  if (entry.readOnly || entry.scope === 'handoff' || entry.salience === 1 || ['user', 'pref'].includes(entry.type)) return false;
  const idle = idleDays(entry, usage, now);
  return idle !== null && idle > days;
}

module.exports = { DORMANT_DAYS, REVIEW_DAYS, readUsage, recordUsage, lastUsedAt, idleDays, isDormant };
