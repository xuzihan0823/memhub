'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { installForAgent } = require('../packages/cli/src/setup');
const core = require('../packages/core/src');

const runnerPath = process.env.MEMHUB_PI_RUNNER;
test('PI host loader: versioned entry replaces cached factory and saves/restores without restarting runner', { skip: !runnerPath }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memhub-host-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'repo');
  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  const previousGlobal = process.env.MEMHUB_GLOBAL_DIR;
  process.env.MEMHUB_GLOBAL_DIR = path.join(root, 'memory');
  const runners = [];
  t.after(async () => {
    await Promise.all(runners.map(r => r.dispose()));
    if (previousGlobal === undefined) delete process.env.MEMHUB_GLOBAL_DIR;
    else process.env.MEMHUB_GLOBAL_DIR = previousGlobal;
    await fs.rm(root, { recursive: true, force: true });
  });
  await installForAgent('pi-desktop', { homeDir: home });
  const plugin = path.join(home, '.pi-desktop/plugins/installed/memhub.universal-memory');
  const manifest = JSON.parse(await fs.readFile(path.join(plugin, 'manifest.json'), 'utf8'));
  const legacyEntry = path.join(plugin, 'extension.js');
  const currentSource = await fs.readFile(legacyEntry, 'utf8');
  await fs.mkdir(path.join(plugin, 'core/src'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'core/src/index.js'), 'module.exports = { legacy: true };\n');
  await fs.writeFile(legacyEntry, "const core = require('./core/src'); module.exports = pi => pi.on('before_provider_request', event => ({...event.payload, cachedLegacyFactory:core.legacy}));\n");
  const { TrustedExtensionRunner } = await import(pathToFileURL(runnerPath).href);
  const queued = [];
  const makeRunner = async (entry, sessionId) => {
    const runner = new TrustedExtensionRunner({ specs: [{ id: entry, entry, label: 'MemHub' }], bridge: {
      cwd, sessionId, publishCommands() {}, publishDiagnostics() {}, getModel() {},
      isIdle: () => true, hasPendingMessages: () => false,
      sendUserMessage: async (text, options) => { queued.push({ sessionId, text, options }); },
    } });
    runners.push(runner);
    const reports = await runner.load();
    assert.equal(reports[0].state, 'loaded', JSON.stringify(runner.getDiagnostics()));
    return runner;
  };
  const payload = { messages: [{ role: 'user', content: 'loader probe' }] };
  await makeRunner(legacyEntry, 'legacy');
  await fs.writeFile(legacyEntry, currentSource);
  const stale = await makeRunner(legacyEntry, 'same-path');
  const staleResult = await stale.emit('before_provider_request', { payload });
  assert.equal(staleResult.cachedLegacyFactory, true);
  const newEntry = path.join(plugin, manifest.contributes.agentExtensions[0]);
  assert.notEqual(newEntry, legacyEntry);
  const a = await makeRunner(newEntry, 'a');
  await a.emit('before_provider_request', { payload });
  await a.emit('agent_end', { messages: [{ role: 'user', content: 'loader probe', timestamp: 1700000000000 }, { role: 'assistant', content: [{ type: 'text', text: 'host reply' }], timestamp: 1700000001000 }] });
  const stores = core.resolveStores({ cwd, globalDir: process.env.MEMHUB_GLOBAL_DIR });
  const records = await core.listSessions(stores);
  assert.equal(records.find(row => row.source_session_id === 'a').last_seq, 2);
  const b = await makeRunner(newEntry, 'b');
  const restored = await b.emit('before_provider_request', { payload: { messages: [{ role: 'user', content: 'continue' }] } });
  assert.match(restored.messages[0].content, /memory-session/);
  assert.match(restored.messages[0].content, /loader probe/);
  assert.match(restored.messages[0].content, /host reply/);
  await a.emit('agent_settled', { aborted: false });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sessionId, 'a');
  assert.ok(queued[0].text.startsWith(core.SELF_CHECK_MARKER));
  assert.deepEqual(a.getDiagnostics(), []);
  assert.deepEqual(b.getDiagnostics(), []);
});
