/** Explicit offline profile copy; source data and existing destinations are preserved. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, constants, readFileSync, lstatSync, realpathSync, statfsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { assertChromiumProfileAvailable, assertChromiumProfileVersion } from './chromium-profile.mjs';

const transient = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort', 'RunningChromeVersion', '.disclaude-profile-copy.json']);
function present(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function canonicalDestination(path) {
  let ancestor = path;
  while (!present(ancestor)) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}
async function inventory(root, signal) {
  const entries = []; let bytes = 0;
  async function walk(directory, depth = 0) {
    if (depth > 100) throw new Error('Profile directory nesting exceeds the copy limit');
    for (const name of (await readdir(directory)).sort()) {
      signal?.throwIfAborted();
      const path = join(directory, name), key = relative(root, path);
      if (directory === root && transient.has(name)) continue;
      const stat = await lstat(path);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Profile copy cannot include symlinks or special files: ${key}`);
      if (entries.length >= 100000) throw new Error('Profile contains too many entries for this copy operation');
      entries.push({ key, directory: stat.isDirectory(), size: stat.isFile() ? stat.size : 0,
        mode: stat.mode & 0o777, modified: stat.mtimeMs });
      if (stat.isDirectory()) await walk(path, depth + 1); else bytes += stat.size;
    }
  }
  await walk(root);
  return { entries, bytes };
}
export async function planChromiumProfileCopy(source, destination, browserVersion, signal) {
  if (!isAbsolute(source || '') || !isAbsolute(destination || '')) throw new Error('Profile copy source and destination must be absolute paths');
  source = realpathSync(source);
  if (!lstatSync(source).isDirectory()) throw new Error('Profile copy source must be a directory');
  if (present(destination)) throw new Error('Profile copy destination already exists; it was preserved');
  destination = canonicalDestination(destination);
  const key = path => process.platform === 'darwin' ? path.normalize('NFD').toLowerCase() : path;
  const from = key(source), to = key(destination);
  if (from === to || to.startsWith(from + '/') || from.startsWith(to + '/')) throw new Error('Profile copy source and destination must not contain one another');
  assertChromiumProfileAvailable(source);
  const localState = join(source, 'Local State');
  const stateStat = lstatSync(localState);
  if (!stateStat.isFile() || stateStat.size > 16 * 1024 * 1024) throw new Error('Source must be a Chromium user-data directory with a regular Local State file');
  const state = JSON.parse(readFileSync(localState, 'utf8'));
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Source Local State must be a JSON object');
  assertChromiumProfileVersion(source, browserVersion);
  const snapshot = await inventory(source, signal);
  let ancestor = dirname(destination);
  while (!present(ancestor)) ancestor = dirname(ancestor);
  const space = statfsSync(ancestor);
  if (space.bavail * space.bsize < snapshot.bytes + 512 * 1024 * 1024) throw new Error('Insufficient space for the profile copy and 512 MiB reserve');
  return { source, destination, browserVersion, ...snapshot };
}

export async function copyChromiumProfile(plan, signal) {
  // Revalidate after the user has confirmed; the preview may no longer be current.
  const current = await planChromiumProfileCopy(plan.source, plan.destination, plan.browserVersion, signal);
  if (JSON.stringify(current.entries) !== JSON.stringify(plan.entries)) throw new Error('Source profile changed after the copy preview; run setup again');
  const parent = dirname(plan.destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, '.disclaude-profile-copy-'));
  const copied = new Map();
  const sizes = new Map(plan.entries.map(entry => [entry.key, entry.size]));
  let reservation;
  try {
    for (const entry of plan.entries) {
      signal?.throwIfAborted();
      const target = join(staging, entry.key);
      if (entry.directory) { await mkdir(target, { mode: 0o700 }); continue; }
      const hash = createHash('sha256'); let received = 0;
      await pipeline(createReadStream(join(plan.source, entry.key), { flags: constants.O_RDONLY | constants.O_NOFOLLOW }),
        new Transform({ transform(chunk, _, done) {
          received += chunk.length;
          if (received > entry.size) return done(new Error('Source file grew during profile copy'));
          hash.update(chunk); done(null, chunk);
        } }),
        createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
      if (received !== entry.size) throw new Error('Source file size changed during profile copy');
      copied.set(entry.key, hash.digest('hex'));
      await chmod(target, entry.mode & 0o700);
    }
    // Compare the source again with the exact bytes copied, and reject concurrent changes.
    assertChromiumProfileAvailable(plan.source);
    const after = await inventory(plan.source, signal);
    if (JSON.stringify(after.entries) !== JSON.stringify(plan.entries)) throw new Error('Source profile changed during copy; destination was not published');
    for (const [key, expected] of copied) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(join(plan.source, key), { signal, end: Math.max(0, sizes.get(key) - 1), flags: constants.O_RDONLY | constants.O_NOFOLLOW })) hash.update(chunk);
      if (hash.digest('hex') !== expected) throw new Error('Source profile content changed during copy; destination was not published');
    }
    assertChromiumProfileAvailable(plan.source);
    if (JSON.stringify((await inventory(plan.source, signal)).entries) !== JSON.stringify(plan.entries)) throw new Error('Source profile changed during verification');
    signal?.throwIfAborted();
    if (present(plan.destination)) throw new Error('Profile copy destination appeared during copy; it was preserved');
    const record = { version: 1, source: plan.source, copiedAt: new Date().toISOString(), files: copied.size, bytes: plan.bytes,
      contentDigest: createHash('sha256').update(JSON.stringify([...copied])).digest('hex') };
    await writeFile(join(staging, '.disclaude-profile-copy.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await mkdir(plan.destination, { mode: 0o700 });
    reservation = await lstat(plan.destination);
    await rename(staging, plan.destination);
    reservation = undefined;
    return record;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (reservation) {
      try {
        const current = await lstat(plan.destination);
        if (current.ino === reservation.ino && current.dev === reservation.dev) await rmdir(plan.destination);
      } catch { /* A nonempty or externally changed reservation is preserved. */ }
    }
  }
}
