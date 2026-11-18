'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../core/src');

const WEB_UI_PATH = path.resolve(__dirname, '../../web-ui/index.html');

function readBodyJson(req, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isTrustedRequest(req) {
  const host = req.headers.host;
  if (!host) return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://${host}`;
}

function createServer({ homeDir, globalDir, defaultCwd } = {}) {
  const getStores = cwd => core.resolveStores({
    homeDir,
    globalDir,
    cwd: cwd || defaultCwd || process.cwd(),
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { error: 'Forbidden: untrusted Host or Origin' });
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/') {
        const html = fs.readFileSync(WEB_UI_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        const stores = getStores(url.searchParams.get('cwd'));
        sendJson(res, 200, { ok: true, version: '0.1.0', globalDir: stores.globalDir, projectDir: stores.projectDir });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/boot') {
        const stores = getStores(url.searchParams.get('cwd'));
        await core.scaffoldGlobalStore(stores.globalDir);
        const data = await core.bootContext(stores);
        sendJson(res, 200, data);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/search') {
        const stores = getStores(url.searchParams.get('cwd'));
        const q = url.searchParams.get('q') || '';
        const scope = url.searchParams.get('scope') || undefined;
        const type = url.searchParams.get('type') || undefined;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 8, 1), 30);
        const strict = url.searchParams.get('strict') === 'true';
        const excludeRaw = url.searchParams.get('exclude') || '';
        const exclude = excludeRaw ? new Set(excludeRaw.split(',').map(s => s.trim()).filter(Boolean)) : undefined;
        const entries = await core.loadAllEntries(stores);
        const hits = core.searchEntries(entries, q, { scope, type, limit, strict, exclude });
        sendJson(res, 200, {
          query: q,
          hits: hits.map(h => ({
            id: h.entry.id,
            scope: h.entry.scope,
            type: h.entry.type,
            title: h.entry.title,
            summary: h.entry.summary,
            keywords: h.entry.keywords,
            salience: h.entry.salience,
            score: h.score,
            relPath: h.entry.relPath,
          })),
          block: core.renderMemoryContext(hits),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/entries') {
        const stores = getStores(url.searchParams.get('cwd'));
        const includeInactive = url.searchParams.get('includeInactive') === 'true';
        const entries = await core.loadAllEntries(stores);
        const list = entries.filter(e => includeInactive || core.isActiveEntry(e)).map(e => ({
          id: e.id,
          scope: e.scope,
          type: e.type,
          title: e.title,
          summary: e.summary,
          keywords: e.keywords,
          salience: e.salience,
          status: e.status,
          supersededBy: e.supersededBy,
          related: e.related,
          last_access: e.last_access,
          created_at: e.created_at,
          origin_agent: e.origin_agent,
          relPath: e.relPath,
          readOnly: e.readOnly,
        }));
        sendJson(res, 200, { globalDir: stores.globalDir, projectDir: stores.projectDir, entries: list });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/load') {
        const stores = getStores(url.searchParams.get('cwd'));
        const id = url.searchParams.get('id');
        if (!id) return sendJson(res, 400, { error: 'id is required' });
        const entry = await core.loadEntryById(stores, id, { touchAccess: true });
        if (!entry) return sendJson(res, 404, { error: `Not found: ${id}` });
        sendJson(res, 200, {
          id: entry.id,
          scope: entry.scope,
          type: entry.type,
          title: entry.title,
          summary: entry.summary,
          keywords: entry.keywords,
          salience: entry.salience,
          status: entry.status,
          supersededBy: entry.supersededBy,
          related: entry.related,
          last_access: entry.last_access,
          relPath: entry.relPath,
          readOnly: entry.readOnly,
          body: entry.body,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/propose') {
        const body = await readBodyJson(req);
        const stores = getStores(body.cwd);
        const result = await core.proposeMemory(stores, {
          items: body.items,
          agent: body.agent || 'http-client',
          sessionId: body.sessionId || null,
          requireReview: Boolean(body.requireReview),
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/inbox') {
        const stores = getStores(url.searchParams.get('cwd'));
        const batches = await core.listInboxBatches(stores);
        sendJson(res, 200, { batches });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/commit') {
        const body = await readBodyJson(req);
        const stores = getStores(body.cwd);
        if (!body.batchId) return sendJson(res, 400, { error: 'batchId is required' });
        const result = await core.commitBatch(stores, body.batchId, body.decisions || {});
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/forget') {
        const body = await readBodyJson(req);
        const stores = getStores(body.cwd);
        if (!body.id) return sendJson(res, 400, { error: 'id is required' });
        const result = await core.forgetEntry(stores, {
          id: body.id,
          mode: body.mode || 'deprecate',
          reason: body.reason || '',
          confirm: body.confirm === true,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/soul') {
        const body = await readBodyJson(req);
        const stores = getStores(body.cwd);
        const result = await core.upsertSoul(stores.globalDir, {
          agentName: body.agentName,
          userAddress: body.userAddress,
          persona: body.persona,
          boundaries: body.boundaries,
        });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/lint') {
        const stores = getStores(url.searchParams.get('cwd'));
        const report = await core.lintStore(stores);
        sendJson(res, 200, report);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/graph') {
        const stores = getStores(url.searchParams.get('cwd'));
        const entries = await core.loadAllEntries(stores);
        sendJson(res, 200, core.buildGraph(entries));
        return;
      }

      sendJson(res, 404, { error: `Unknown route: ${req.method} ${pathname}` });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
  });

  return server;
}

function startDaemon({ port = Number(process.env.MEMHUB_PORT || 4789), host = '127.0.0.1', ...opts } = {}) {
  const server = createServer(opts);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: addr.port, host, url: `http://${host}:${addr.port}` });
    });
  });
}

module.exports = { createServer, startDaemon };
