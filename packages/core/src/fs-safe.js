'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 2000;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

// In-process queue + cross-process atomic lock file (.memhub.lock)
const writeQueues = new Map();
const LOCK_STALE_MS = 15000;

async function acquireProcessLock(scopeRoot, timeoutMs = 5000) {
  await fsp.mkdir(scopeRoot, { recursive: true });
  const lockPath = path.join(scopeRoot, '.memhub.lock');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await fsp.open(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      await handle.close();
      return async () => {
        await fsp.unlink(lockPath).catch(() => {});
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await fsp.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fsp.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for memory store lock: ${lockPath}`);
      }
      await new Promise(r => setTimeout(r, 15));
    }
  }
}

function enqueueWrite(scopeRoot, fn) {
  const key = path.resolve(scopeRoot);
  const prev = writeQueues.get(key) || Promise.resolve();
  const run = prev.then(async () => {
    const release = await acquireProcessLock(key);
    try {
      return await fn();
    } finally {
      await release();
    }
  }, async () => {
    const release = await acquireProcessLock(key);
    try {
      return await fn();
    } finally {
      await release();
    }
  });
  writeQueues.set(key, run.catch(() => {}));
  return run;
}

function inside(base, target) {
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function validateRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath || path.isAbsolute(relPath) || relPath.includes('\\')) {
    throw new Error(`Invalid relative path: ${relPath}`);
  }
  const parts = relPath.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
  return parts;
}

async function assertNoSymlinks(rootReal, parts, { missingOk = false } = {}) {
  let cur = rootReal;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await fsp.lstat(cur);
    } catch (err) {
      if (missingOk && err.code === 'ENOENT') return false;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink rejected in memory path: ${parts.join('/')}`);
    }
  }
  return true;
}

async function safeReadText(rootDir, relPath) {
  const rootReal = await fsp.realpath(rootDir);
  const parts = validateRelPath(relPath);
  await assertNoSymlinks(rootReal, parts);
  const full = path.join(rootReal, ...parts);
  let handle;
  try {
    handle = await fsp.open(full, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ELOOP') throw new Error(`Symlink rejected: ${relPath}`);
    throw err;
  }
  try {
    const [opened, named] = await Promise.all([handle.stat(), fsp.stat(full)]);
    if (!opened.isFile() || opened.nlink > 1 || opened.size > MAX_FILE_BYTES) {
      throw new Error(`Unsupported or oversized memory file: ${relPath}`);
    }
    if (opened.ino !== named.ino || opened.dev !== named.dev) {
      throw new Error(`File changed during read: ${relPath}`);
    }
    const real = await fsp.realpath(full);
    if (!inside(rootReal, real) || real !== full) {
      throw new Error(`Path escapes memory root: ${relPath}`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function atomicWriteText(rootDir, relPath, content) {
  return enqueueWrite(rootDir, async () => {
    await fsp.mkdir(rootDir, { recursive: true });
    const rootReal = await fsp.realpath(rootDir);
    const parts = validateRelPath(relPath);
    const dirParts = parts.slice(0, -1);
    await assertNoSymlinks(rootReal, parts, { missingOk: true });
    const dir = path.join(rootReal, ...dirParts);
    await fsp.mkdir(dir, { recursive: true });
    await assertNoSymlinks(rootReal, dirParts);
    const dirReal = await fsp.realpath(dir);
    if (!inside(rootReal, dirReal) || dirReal !== dir) {
      throw new Error(`Directory escapes memory root: ${relPath}`);
    }
    const full = path.join(dir, parts[parts.length - 1]);
    const temp = path.join(dir, `.${parts[parts.length - 1]}.${crypto.randomUUID()}.tmp`);
    const handle = await fsp.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(content, 'utf8');
      const [opened, named] = await Promise.all([handle.stat(), fsp.lstat(temp)]);
      if (opened.ino !== named.ino || opened.dev !== named.dev) {
        throw new Error(`Temp file swap detected: ${relPath}`);
      }
    } catch (err) {
      await handle.close().catch(() => {});
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw err;
    }
    await handle.close();
    await assertNoSymlinks(rootReal, parts, { missingOk: true });
    await fsp.rename(temp, full);
    const landed = await fsp.realpath(full);
    if (!inside(rootReal, landed) || landed !== full) {
      await fsp.rm(full, { force: true }).catch(() => {});
      throw new Error(`Target escaped memory root: ${relPath}`);
    }
  });
}

async function safeRemove(rootDir, relPath) {
  return enqueueWrite(rootDir, async () => {
    const rootReal = await fsp.realpath(rootDir);
    const parts = validateRelPath(relPath);
    await assertNoSymlinks(rootReal, parts);
    const full = path.join(rootReal, ...parts);
    const real = await fsp.realpath(full);
    if (!inside(rootReal, real) || real !== full) {
      throw new Error(`Delete escapes memory root: ${relPath}`);
    }
    await fsp.unlink(full);
  });
}

async function walkMarkdownFiles(rootDir, subDirs) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const rootReal = await fsp.realpath(rootDir);
  const results = [];

  async function walk(relDir) {
    if (results.length >= MAX_FILES) return;
    const parts = relDir ? validateRelPath(relDir) : [];
    try {
      await assertNoSymlinks(rootReal, parts);
    } catch {
      return;
    }
    const abs = path.join(rootReal, ...parts);
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= MAX_FILES) return;
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const nextRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (nextRel === 'raw' || nextRel === 'inbox' || nextRel === 'archive' || nextRel.endsWith('/inbox')) continue;
        await walk(nextRel);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        try {
          const st = await fsp.lstat(path.join(abs, entry.name));
          if (st.nlink === 1 && st.size <= MAX_FILE_BYTES) results.push(nextRel);
        } catch {
          // skip unreadable
        }
      }
    }
  }

  for (const sub of subDirs) {
    const absSub = path.join(rootReal, sub);
    if (fs.existsSync(absSub)) {
      const st = fs.lstatSync(absSub);
      if (st.isDirectory() && !st.isSymbolicLink()) await walk(sub);
      else if (st.isFile() && !st.isSymbolicLink() && /\.md$/i.test(sub)) results.push(sub);
    }
  }
  return results;
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_FILES,
  safeReadText,
  atomicWriteText,
  safeRemove,
  walkMarkdownFiles,
};
