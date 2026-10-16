#!/usr/bin/env node
// Read-only inventory. This command deliberately has no delete/apply mode.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const inside = (path, root) => path === root || path.startsWith(root + sep);
const canonical = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
function run(command, args, cwd) {
  try {
    return {
      ok: true,
      text: execFileSync(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
      }),
    };
  } catch {
    return { ok: false, text: '' };
  }
}

export function measureTree(path) {
  const inodes = new Map();
  let logicalBytes = 0,
    newestMtimeMs = 0,
    files = 0;
  const errors = [];
  function visit(entry) {
    try {
      const info = lstatSync(entry);
      newestMtimeMs = Math.max(newestMtimeMs, info.mtimeMs);
      logicalBytes += info.size;
      files++;
      const key = `${info.dev}:${info.ino}`;
      const value = inodes.get(key) ?? {
        allocatedBytes: info.blocks * 512,
        links: info.nlink,
        occurrences: 0,
        directory: info.isDirectory(),
      };
      value.occurrences++;
      inodes.set(key, value);
      if (info.isDirectory()) for (const name of readdirSync(entry)) visit(join(entry, name));
    } catch (error) {
      errors.push({ path: entry, code: error.code ?? 'UNKNOWN' });
    }
  }
  visit(path);
  let allocatedBytes = 0,
    exclusiveAllocatedBytes = 0;
  for (const value of inodes.values()) {
    allocatedBytes += value.allocatedBytes;
    // Links outside this tree survive removal. Directories have structural links.
    if (value.directory || value.links <= value.occurrences)
      exclusiveAllocatedBytes += value.allocatedBytes;
  }
  return {
    logicalBytes,
    allocatedBytes,
    exclusiveAllocatedBytes,
    files,
    newestMtimeMs,
    errors,
    inodes,
  };
}

function children(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
function deliveryPrefixes(root, result, depth = 0) {
  if (depth > 8) return;
  for (const entry of children(root)) {
    if (
      !entry.isDirectory() ||
      ['node_modules', '.git', 'workspace', 'projects', 'data', 'logs', 'cache'].includes(
        entry.name
      )
    )
      continue;
    const path = join(root, entry.name);
    if (
      /^(?:prefix(?:[-_].*)?|sdk-prefix(?:[-_].*)?)$/.test(entry.name) &&
      children(join(path, 'lib', 'node_modules')).some((item) => item.name === 'disclaude')
    ) {
      result.push({ kind: 'delivery-prefix', path });
    } else deliveryPrefixes(path, result, depth + 1);
  }
}

export function inventory(options, observations) {
  const now = options.now ?? Date.now();
  const repo = canonical(options.repo);
  const candidates = [];
  deliveryPrefixes(options.deliveryRoot, candidates);
  for (const entry of children(options.releaseRoot)) {
    if (entry.isDirectory())
      candidates.push({ kind: 'release', path: join(options.releaseRoot, entry.name) });
  }
  const worktrees = observations.worktrees ?? run('git', ['worktree', 'list', '--porcelain'], repo);
  if (worktrees.ok) {
    for (const block of worktrees.text.trim().split('\n\n')) {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      if (path)
        candidates.push({
          kind: 'worktree',
          path,
          head: block.match(/^HEAD (.+)$/m)?.[1],
          branch: block.match(/^branch (.+)$/m)?.[1] ?? 'detached',
        });
    }
  }
  for (const name of ['_cacache', '_npx']) {
    for (const entry of name === '_npx'
      ? children(join(options.npmCache, name))
      : children(options.npmCache).filter((entry) => entry.name === name)) {
      const path =
        name === '_npx' ? join(options.npmCache, name, entry.name) : join(options.npmCache, name);
      if (entry.isDirectory())
        candidates.push({ kind: name === '_npx' ? 'npx-cache' : 'npm-cache', path });
    }
  }
  const processScan = observations.processes ?? run('ps', ['-axo', 'pid=,command=']);
  const openFiles = observations.openFiles ?? run('lsof', ['-nP', '-Fpn']);
  const referencesComplete = processScan.ok && openFiles.ok;
  const processes = processScan.text
    .split('\n')
    .map((line) => ({ pid: Number(line.trim().match(/^\d+/)?.[0]), command: line }));
  const fileReferences = [];
  let pid;
  for (const line of openFiles.text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n/')) fileReferences.push({ pid, path: canonical(line.slice(1)) });
  }
  const pinnedPaths = [];
  for (const path of options.pin ?? []) pinnedPaths.push(canonical(path));
  // Common service selectors are references even while the service is stopped.
  for (const entry of children(dirname(options.releaseRoot))) {
    const path = join(dirname(options.releaseRoot), entry.name);
    if (entry.isSymbolicLink()) {
      try {
        pinnedPaths.push(canonical(resolve(dirname(path), readlinkSync(path))));
      } catch {
        /* keep unreadable selectors untrusted */
      }
    }
  }
  const unique = new Map();
  for (const candidate of candidates) {
    const path = canonical(candidate.path);
    const prior = unique.get(path);
    unique.set(
      path,
      prior
        ? {
            ...prior,
            ...candidate,
            kind: prior.kind,
            kinds: [...new Set([...prior.kinds, candidate.kind])],
          }
        : { ...candidate, path, kinds: [candidate.kind] }
    );
  }
  const rows = [...unique.values()].map((candidate) => {
    const size = measureTree(candidate.path);
    const activePids = new Set();
    for (const process of processes)
      if (process.pid && process.command.includes(candidate.path)) activePids.add(process.pid);
    for (const file of fileReferences)
      if (inside(file.path, candidate.path)) activePids.add(file.pid);
    const reasons = [];
    if (activePids.size) reasons.push('running-process-reference');
    if (pinnedPaths.some((path) => inside(path, candidate.path) || inside(candidate.path, path)))
      reasons.push('pinned-reference');
    if (!referencesComplete) reasons.push('process-reference-scan-incomplete');
    if (size.errors.length) reasons.push('filesystem-scan-incomplete');
    const ageDays = Math.max(0, (now - size.newestMtimeMs) / 86_400_000);
    if (ageDays < options.olderThanDays) reasons.push('recent');
    const row = { ...candidate, ...size, ageDays, activePids: [...activePids], reasons };
    if (candidate.kinds.includes('worktree')) {
      const status = run('git', ['status', '--porcelain=v1', '--ignored=matching'], candidate.path);
      const upstream = run(
        'git',
        ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
        candidate.path
      );
      row.git = {
        statusKnown: status.ok,
        changedOrUntracked: status.text.split('\n').filter((line) => line && !line.startsWith('!!'))
          .length,
        ignoredEntries: status.text.split('\n').filter((line) => line.startsWith('!!')).length,
        upstreamKnown: upstream.ok,
        aheadBehind: upstream.ok ? upstream.text.trim().split(/\s+/).map(Number) : null,
      };
      reasons.push('worktree-requires-owner-review');
      if (candidate.path === repo) reasons.push('report-source-worktree');
      if (!status.ok || row.git.changedOrUntracked) reasons.push('uncommitted-or-unknown-content');
      if (!upstream.ok || row.git.aheadBehind[0] > 0 || candidate.branch === 'detached')
        reasons.push('unpublished-or-detached-history');
    }
    if (candidate.kinds.some((kind) => kind.endsWith('cache')))
      reasons.push('shared-cache-requires-owner-review');
    return row;
  });
  for (const kind of ['release', 'delivery-prefix']) {
    rows
      .filter((row) => row.kinds.includes(kind))
      .sort((a, b) => b.newestMtimeMs - a.newestMtimeMs)
      .slice(0, options.keepLatest)
      .forEach((row) => row.reasons.push('keep-latest'));
  }
  const allInodes = new Map();
  for (const row of rows) for (const [key, value] of row.inodes) allInodes.set(key, value);
  // A retained nested entry also protects a broader candidate that contains it.
  for (const row of [...rows].sort((a, b) => b.path.length - a.path.length)) {
    if (
      !row.reasons.length &&
      rows.some((child) => child !== row && child.reasons.length && inside(child.path, row.path))
    ) {
      row.reasons.push('contains-retained-entry');
    }
  }
  const eligibleRoots = [];
  const eligibleInodes = new Map();
  for (const row of rows
    .filter((row) => !row.reasons.length)
    .sort((a, b) => a.path.length - b.path.length)) {
    if (eligibleRoots.some((path) => inside(row.path, path))) continue;
    eligibleRoots.push(row.path);
    for (const [key, inode] of row.inodes) {
      const prior = eligibleInodes.get(key);
      eligibleInodes.set(key, {
        ...inode,
        occurrences: inode.occurrences + (prior?.occurrences ?? 0),
      });
    }
  }
  const estimatedReclaimableBytes = [...eligibleInodes.values()].reduce(
    (sum, inode) =>
      sum + (inode.directory || inode.links <= inode.occurrences ? inode.allocatedBytes : 0),
    0
  );
  for (const row of rows) {
    // A prefix may contain runtime-created user data. An unreferenced old tree
    // is a review candidate, never proof that deleting it is authorized.
    row.disposition = row.reasons.length ? 'retain' : 'review-stale-unreferenced';
    row.estimatedReclaimableBytes = row.reasons.length ? 0 : row.exclusiveAllocatedBytes;
    delete row.inodes;
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    policy: { olderThanDays: options.olderThanDays, keepLatest: options.keepLatest },
    observations: {
      processScanComplete: processScan.ok,
      openFileScanComplete: openFiles.ok,
      worktreeScanComplete: worktrees.ok,
    },
    totals: {
      logicalBytes: rows.reduce((sum, row) => sum + row.logicalBytes, 0),
      uniqueAllocatedBytes: [...allInodes.values()].reduce(
        (sum, inode) => sum + inode.allocatedBytes,
        0
      ),
      estimatedReclaimableBytes,
    },
    limitations: [
      'Filesystem block counts are estimates: APFS clones, compression and snapshots can change actual reclaimed space.',
      'Age uses the newest directory entry/file modification time; it is not proof of last use.',
      'Process/file observations are a point-in-time local-user view; recheck service definitions, config, data ownership and processes before any manual removal.',
      'Worktrees and shared caches require separate owner review; no removal is performed.',
    ],
    entries: rows,
  };
}

export function parseOptions(args) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const options = {
    repo,
    deliveryRoot: join(repo, '.local'),
    releaseRoot: join(homedir(), '.disclaude', 'releases'),
    npmCache: join(homedir(), '.npm'),
    olderThanDays: 7,
    keepLatest: 2,
    pin: [],
  };
  const fields = {
    '--repo': 'repo',
    '--delivery-root': 'deliveryRoot',
    '--release-root': 'releaseRoot',
    '--npm-cache': 'npmCache',
    '--older-than-days': 'olderThanDays',
    '--keep-latest': 'keepLatest',
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') return null;
    if (key === '--pin' && args[i + 1]) {
      options.pin.push(resolve(args[++i]));
      continue;
    }
    if (!fields[key] || args[i + 1] === undefined || args[i + 1].startsWith('--'))
      throw new Error(`Unknown or incomplete option: ${key}`);
    const value = args[++i];
    if (['olderThanDays', 'keepLatest'].includes(fields[key])) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0)
        throw new Error(`Expected a non-negative integer: ${key}`);
      options[fields[key]] = number;
    } else options[fields[key]] = resolve(value);
  }
  return options;
}

if (process.argv[1] && canonical(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  if (!options)
    console.log(
      'Usage: node scripts/delivery-retention.mjs [--repo PATH] [--delivery-root PATH] [--release-root PATH] [--npm-cache PATH] [--older-than-days 7] [--keep-latest 2] [--pin PATH ...]\nPrint a read-only JSON retention preview. There is no cleanup mode.'
    );
  else console.log(JSON.stringify(inventory(options, {}), null, 2));
}
