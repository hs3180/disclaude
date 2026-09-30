/** Verified Chromium snapshot candidates, isolated from browser profiles/services. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statfsSync } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const origin = 'https://commondatastorage.googleapis.com/chromium-browser-snapshots';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reserve = 512 * 1024 * 1024;
const layouts = {
  'darwin-arm64': { platform: 'Mac_Arm', archive: 'chrome-mac.zip', binary: 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', app: 'chrome-mac/Chromium.app' },
  'darwin-x64': { platform: 'Mac', archive: 'chrome-mac.zip', binary: 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', app: 'chrome-mac/Chromium.app' },
  'linux-x64': { platform: 'Linux_x64', archive: 'chrome-linux.zip', binary: 'chrome-linux/chrome' },
};
export function chromiumDownloadLayout(platform = process.platform, arch = process.arch) {
  const layout = layouts[`${platform}-${arch}`];
  if (!layout) throw new Error(`Official desktop Chromium snapshot download is unavailable for ${platform}/${arch}; select an existing browser executable`);
  return layout;
}
export async function planChromiumDownload({ revision, directory, signal } = {}) {
  const layout = chromiumDownloadLayout();
  if (!revision) {
    const response = await fetch(`${origin}/${layout.platform}/LAST_CHANGE`, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Chromium revision lookup failed (${response.status})`);
    revision = (await response.text()).trim();
  }
  if (!/^[1-9]\d{3,9}$/.test(revision)) throw new Error('Chromium revision must be a numeric snapshot revision');
  const url = `${origin}/${layout.platform}/${revision}/${layout.archive}`;
  const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Chromium snapshot metadata failed (${response.status})`);
  const size = Number(response.headers.get('content-length'));
  const md5 = response.headers.get('x-goog-hash')?.match(/(?:^|,\s*)md5=([^, ]+)/)?.[1];
  const generation = response.headers.get('x-goog-generation');
  if (!Number.isSafeInteger(size) || size < 1 || size > 512 * 1024 * 1024 || !md5 || Buffer.from(md5, 'base64').length !== 16 || !/^\d+$/.test(generation || '')) throw new Error('Snapshot is missing bounded size/checksum/generation metadata');
  const base = directory || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'disclaude/browsers');
  if (!isAbsolute(base)) throw new Error('Browser download directory must be absolute');
  return { ...layout, revision, url, size, md5, generation, destination: join(base, `${layout.platform}-${revision}`) };
}

function requireSpace(path, bytes) {
  while (!existsSync(path)) path = dirname(path);
  const stats = statfsSync(path);
  if (stats.bavail * stats.bsize < bytes + reserve) throw new Error('Insufficient space for this browser candidate and the 512 MiB reserve');
}
async function fileDigest(path, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
async function treeDigest(root, signal) {
  if (!lstatSync(root).isDirectory()) throw new Error('Browser candidate payload must be a real directory');
  const hash = createHash('sha256');
  async function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      signal?.throwIfAborted();
      const path = join(dir, name), stat = lstatSync(path), relative = path.slice(root.length + 1);
      hash.update(relative + '\0' + (stat.mode & 0o777) + '\0');
      if (stat.isSymbolicLink()) hash.update('link\0' + readlinkSync(path));
      else if (stat.isDirectory()) { hash.update('directory\0'); await walk(path); }
      else if (stat.isFile()) hash.update('file\0' + await fileDigest(path, signal));
      else throw new Error('Unexpected special file in browser candidate');
      hash.update('\0');
    }
  }
  await walk(root);
  return hash.digest('hex');
}

/** Validate paths, symlink chains and extraction size before invoking the OS ZIP tool. */
export async function inspectChromiumZip(archive, caseInsensitive = process.platform === 'darwin') {
  const file = await open(archive, 'r');
  try {
    const size = (await file.stat()).size, tail = Buffer.alloc(Math.min(size, 65557));
    await file.read(tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Invalid or multi-disk browser ZIP');
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (count === 65535 || length > 16 * 1024 * 1024 || offset + length > size - 22) throw new Error('Unsupported ZIP64 or oversized directory');
    const central = Buffer.alloc(length); await file.read(central, 0, length, offset);
    const names = new Set(), links = new Map(); let cursor = 0, expanded = 0;
    const key = path => caseInsensitive ? path.normalize('NFD').toLowerCase() : path;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory entry');
      const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10);
      const compressed = central.readUInt32LE(cursor + 20), uncompressed = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28), extra = central.readUInt16LE(cursor + 30), comment = central.readUInt16LE(cursor + 32);
      const mode = central.readUInt32LE(cursor + 38) >>> 16, localOffset = central.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameLength + extra + comment;
      if (next > central.length || flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff || uncompressed > 1024 * 1024 * 1024) throw new Error('Unsupported browser ZIP entry');
      const bytes = central.subarray(cursor + 46, cursor + 46 + nameLength), name = bytes.toString('utf8');
      const parts = name.replace(/\/$/, '').split('/');
      if (!Buffer.from(name).equals(bytes) || /[\\\0]/.test(name) || name.startsWith('/') || parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Unsafe browser ZIP path');
      const local = Buffer.alloc(30); await file.read(local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || local.readUInt16LE(26) !== nameLength) throw new Error('ZIP local and central entries disagree');
      const localName = Buffer.alloc(nameLength); await file.read(localName, 0, nameLength, localOffset + 30);
      if (!localName.equals(bytes) || localOffset + 30 + nameLength + local.readUInt16LE(28) + compressed > offset) throw new Error('ZIP member name or data boundary mismatch');
      const normalized = key(parts.join('/'));
      if (names.has(normalized)) throw new Error('Duplicate browser ZIP path');
      names.add(normalized); expanded += uncompressed;
      if (expanded > 3 * 1024 * 1024 * 1024) throw new Error('Browser ZIP exceeds the extraction limit');
      if ((mode & 0xf000) === 0xa000) {
        if (compressed > 65536 || uncompressed > 4096) throw new Error('Oversized browser ZIP symlink');
        const header = Buffer.alloc(30); await file.read(header, 0, 30, localOffset);
        if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid ZIP local entry');
        const start = localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        if (start + compressed > size) throw new Error('Truncated ZIP symlink');
        const data = Buffer.alloc(compressed); await file.read(data, 0, compressed, start);
        const target = (method === 8 ? inflateRawSync(data, { maxOutputLength: 4096 }) : data).toString('utf8');
        if (!target || target.startsWith('/') || /[\\\0]/.test(target)) throw new Error('Unsafe browser ZIP symlink target');
        links.set(normalized, target);
      } else if ((mode & 0xf000) && ![0x4000, 0x8000].includes(mode & 0xf000)) throw new Error('Unsupported special entry in browser ZIP');
      cursor = next;
    }
    if (cursor !== central.length) throw new Error('Unexpected browser ZIP directory data');
    function resolveLink(parts, stack = [], depth = 0) {
      if (depth > 40) throw new Error('Browser ZIP symlink cycle');
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part || part === '.') continue;
        if (part === '..') { if (!stack.length) throw new Error('Browser ZIP symlink escapes extraction root'); stack.pop(); continue; }
        const path = key([...stack, part].join('/'));
        if (links.has(path)) return resolveLink([...links.get(path).split('/'), ...parts.slice(i + 1)], stack, depth + 1);
        stack.push(part);
      }
      return stack;
    }
    for (const name of names) resolveLink(name.split('/'));
    return { entries: count, expandedBytes: expanded };
  } finally { await file.close(); }
}

export async function installChromiumCandidate(plan, { headless = false, allowUnverifiedSignature = false, confirmSignature, signal } = {}) {
  const base = dirname(plan.destination);
  if (existsSync(plan.destination)) {
    const record = JSON.parse(readFileSync(join(plan.destination, 'verification.json'), 'utf8'));
    const payload = join(plan.destination, 'payload');
    if (record.version !== 1 || record.url !== plan.url || record.generation !== plan.generation || record.md5 !== plan.md5 || !record.usable || await treeDigest(payload, signal) !== record.treeSha256) throw new Error('Existing candidate is not verified or has changed; it was preserved');
    if (record.signature?.status === 'failed' && !allowUnverifiedSignature && !await confirmSignature?.(record.signature)) throw new Error('Explicit acceptance is required for this macOS signature result');
    return { ...record, binary: join(payload, plan.binary), reused: true };
  }
  requireSpace(base, plan.size * 2);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const lock = `${plan.destination}.install-lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Candidate installation lock exists at ${lock}; inspect its owner before removing a stale lock`); throw error; }
  let staging;
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    staging = await mkdtemp(join(base, '.chromium-download-'));
    const archive = join(staging, 'browser.zip'), payload = join(staging, 'payload');
    const response = await fetch(`${plan.url}?generation=${plan.generation}`, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
    if (!response.ok || response.headers.get('x-goog-generation') !== plan.generation) throw new Error('Snapshot generation changed or download failed');
    const md5 = createHash('md5'), sha256 = createHash('sha256'); let received = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, done) {
      received += chunk.length;
      if (received > plan.size) return done(new Error('Snapshot exceeded advertised size'));
      md5.update(chunk); sha256.update(chunk); done(null, chunk);
    } }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    if (received !== plan.size || md5.digest('base64') !== plan.md5) throw new Error('Chromium download integrity check failed');
    const archiveSha256 = sha256.digest('hex');
    const index = await inspectChromiumZip(archive); requireSpace(staging, index.expandedBytes);
    await mkdir(payload, { mode: 0o700 });
    await exec(process.platform === 'darwin' ? 'ditto' : 'unzip', process.platform === 'darwin'
      ? ['-x', '-k', archive, payload] : ['-q', archive, '-d', payload], { timeout: 120000, maxBuffer: 1024 * 1024, signal });
    const binary = join(payload, plan.binary), actual = await realpath(binary);
    if (!actual.startsWith(await realpath(payload) + '/')) throw new Error('Extracted browser executable escapes candidate');
    let signature = { status: 'not-applicable' };
    if (plan.app) {
      try { await exec('codesign', ['--verify', '--deep', '--strict', join(payload, plan.app)], { timeout: 30000, signal }); signature = { status: 'verified' }; }
      catch (error) { signal?.throwIfAborted(); signature = { status: 'failed', detail: String(error.stderr || error.message).slice(0, 2000) }; }
      if (signature.status === 'failed' && !allowUnverifiedSignature && !await confirmSignature?.(signature)) throw new Error('Chromium archive integrity passed, but macOS signature verification failed; review the signature result before explicitly accepting it');
    }
    const version = (await exec(binary, ['--version'], { timeout: 10000, signal })).stdout.trim();
    let result;
    try {
      result = await exec(process.execPath, [join(project, 'bin/disclaude.js'), 'browser', 'doctor', '--binary', binary, ...(headless ? ['--headless'] : [])], { timeout: 90000, maxBuffer: 1024 * 1024, signal });
    } catch (error) {
      if (process.platform === 'linux' && /No usable sandbox!/.test(String(error.stderr))) {
        throw new Error('Downloaded Chromium cannot establish its Linux sandbox in this environment. Candidate discarded; current service unchanged. Select a system-installed browser with working sandbox support, or ask the system administrator to review the Chromium sandbox policy. Setup does not disable the sandbox or change system security settings. Details: https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md');
      }
      throw error;
    }
    const diagnosis = JSON.parse(result.stdout);
    if (!diagnosis.usable) throw new Error('Downloaded Chromium failed its temporary-profile diagnosis');
    const record = { version: 1, revision: plan.revision, platform: plan.platform, url: plan.url, generation: plan.generation,
      size: received, md5: plan.md5, archiveSha256, treeSha256: await treeDigest(payload, signal), browserVersion: version, signature,
      usable: true, diagnosisMode: headless ? 'headless' : 'headed', temporaryProfileCookiePersistence: diagnosis.cookiePersistence, verifiedAt: new Date().toISOString() };
    await writeFile(join(staging, 'verification.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rm(archive);
    if (existsSync(plan.destination)) throw new Error('Another candidate appeared during download; existing directory preserved');
    await rename(staging, plan.destination);
    return { ...record, binary: join(plan.destination, 'payload', plan.binary), reused: false };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
