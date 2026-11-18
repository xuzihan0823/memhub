'use strict';

const { isActiveEntry } = require('./markdown');
const { searchEntries, matchEntriesByPath, buildRetrievalQuery, renderMemoryContext, termGroups } = require('./search');
const { loadAllEntries } = require('./store');
const { rerankConfig, rerankWithModel } = require('./rerank');
const { recordUsage } = require('./usage');

async function retrieveContext(stores, {
  query = '',
  previousContext = '',
  paths = [],
  exclude = [],
  limit = 5,
  loadTool = 'memory_load',
  rerank = rerankConfig(),
  fetchImpl,
} = {}) {
  const excludeSet = new Set(exclude);
  const fullQuery = buildRetrievalQuery(query, previousContext);
  const hasQuery = termGroups(fullQuery).length > 0;
  if (!hasQuery && !paths.length) return { ids: [], block: null, mode: 'empty' };

  const entries = await loadAllEntries(stores);
  const pathHits = matchEntriesByPath(entries, paths, { exclude: excludeSet, limit });
  const pathIds = new Set(pathHits.map(h => h.entry.id));
  const skip = new Set([...excludeSet, ...pathIds]);
  const remaining = Math.max(limit - pathHits.length, 0);

  let textHits = [];
  let mode = 'keyword';
  if (hasQuery && remaining > 0) {
    if (rerank) {
      const candidates = searchEntries(entries, fullQuery, { limit: 40, exclude: skip }).map(h => h.entry);
      const pool = candidates.length >= 8
        ? candidates
        : [...candidates, ...entries.filter(e => isActiveEntry(e) && !skip.has(e.id) && !candidates.includes(e))].slice(0, 40);
      const picked = await rerankWithModel(fullQuery, pool, { config: rerank, limit: remaining, fetchImpl });
      if (picked) {
        textHits = picked.map(entry => ({ entry, score: 0, rawScore: 0, strong: 1, weak: 0 }));
        mode = 'rerank';
      } else {
        mode = 'keyword-fallback';
      }
    }
    if (mode !== 'rerank') {
      textHits = searchEntries(entries, fullQuery, { strict: true, limit: remaining, exclude: skip });
    }
  }

  const hits = [...pathHits, ...textHits];
  await recordUsage(stores, hits.map(h => h.entry.id), 'inject');
  return {
    ids: hits.map(h => h.entry.id),
    block: renderMemoryContext(hits, loadTool),
    mode,
  };
}

module.exports = { retrieveContext };
