import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  rmSync,
  utimesSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, measureTree, parseOptions } from './delivery-retention.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'disclaude-retention-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    repo: root,
    deliveryRoot: join(root, 'delivery'),
    releaseRoot: join(root, 'releases'),
    npmCache: join(root, 'cache'),
    olderThanDays: 7,
    keepLatest: 0,
    now: Date.now() + 30 * 86_400_000,
  };
  const observations = {
    processes: { ok: true, text: '' },
    openFiles: { ok: true, text: '' },
    worktrees: { ok: true, text: '' },
  };
  return { root, options, observations };
}
function prefix(path) {
  mkdirSync(join(path, 'lib/node_modules/disclaude'), { recursive: true });
  writeFileSync(join(path, 'lib/node_modules/disclaude/payload'), Buffer.alloc(8192, 42));
}

test('old unreferenced prefixes are previewed; active, pinned and newest prefixes remain', (t) => {
  const { root, options, observations } = fixture(t);
  const stale = join(options.deliveryRoot, 'old/prefix');
  prefix(stale);
  const live = join(options.releaseRoot, 'live');
  prefix(live);
  const pinned = join(options.releaseRoot, 'pinned');
  prefix(pinned);
  symlinkSync(pinned, join(root, 'current'));
  observations.processes.text = `123 node ${live}/bin/disclaude`;
  observations.openFiles.text = `p456\nn${live}/lib/node_modules/disclaude`;
  const before = readdirSync(root);
  const report = inventory(options, observations);
  assert.equal(report.readOnly, true);
  assert.equal(
    report.entries.find((row) => row.path === stale).disposition,
    'review-stale-unreferenced'
  );
  assert(report.entries.find((row) => row.path === stale).estimatedReclaimableBytes > 0);
  assert.deepEqual(report.entries.find((row) => row.path === live).activePids, [123, 456]);
  assert(report.entries.find((row) => row.path === pinned).reasons.includes('pinned-reference'));
  assert.equal(report.entries.find((row) => row.path === live).estimatedReclaimableBytes, 0);
  assert.deepEqual(readdirSync(root), before);
  assert.equal(readFileSync(join(stale, 'lib/node_modules/disclaude/payload')).length, 8192);
  options.keepLatest = 1;
  assert(
    inventory(options, observations)
      .entries.find((row) => row.path === stale)
      .reasons.includes('keep-latest')
  );
});

test('hard links count once and external links are excluded from the reclaim estimate; symlinks are not followed', (t) => {
  const { root } = fixture(t);
  const path = join(root, 'tree');
  mkdirSync(path);
  writeFileSync(join(path, 'a'), Buffer.alloc(65536, 10));
  linkSync(join(path, 'a'), join(path, 'b'));
  const size = measureTree(path);
  assert(size.logicalBytes > size.allocatedBytes);
  assert.equal(size.allocatedBytes, size.exclusiveAllocatedBytes);
  linkSync(join(path, 'a'), join(root, 'external-link'));
  symlinkSync(root, join(path, 'loop'));
  const external = measureTree(path);
  assert(external.exclusiveAllocatedBytes < external.allocatedBytes);
  assert.equal(external.files, 4);
});

test('recent content and incomplete observations are retained without claiming recoverable bytes', (t) => {
  const { options, observations } = fixture(t);
  const path = join(options.deliveryRoot, 'old/prefix');
  prefix(path);
  utimesSync(
    join(path, 'lib/node_modules/disclaude/payload'),
    new Date(options.now),
    new Date(options.now)
  );
  let row = inventory(options, observations).entries[0];
  assert(row.reasons.includes('recent'));
  assert.equal(row.estimatedReclaimableBytes, 0);
  options.now += 10 * 86_400_000;
  observations.openFiles.ok = false;
  row = inventory(options, observations).entries[0];
  assert(row.reasons.includes('process-reference-scan-incomplete'));
  assert.equal(row.estimatedReclaimableBytes, 0);
});

test('cache and dirty or detached worktrees need explicit owner review', (t) => {
  const { root, options, observations } = fixture(t);
  mkdirSync(join(options.npmCache, '_cacache'), { recursive: true });
  mkdirSync(join(options.npmCache, '_npx/id'), { recursive: true });
  observations.worktrees.text = `worktree ${root}\nHEAD abcdef\ndetached\n\n`;
  const report = inventory(options, observations);
  assert.equal(report.entries.length, 3);
  assert(report.entries.every((row) => row.estimatedReclaimableBytes === 0));
  assert(
    report.entries
      .find((row) => row.kind === 'worktree')
      .reasons.includes('unpublished-or-detached-history')
  );
});

test('CLI rejects destructive, unknown and malformed options', () => {
  for (const args of [
    ['--apply'],
    ['--older-than-days', '-1'],
    ['--keep-latest', '0.5'],
    ['--pin'],
    ['--repo'],
  ])
    assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(['--keep-latest', '0']).keepLatest, 0);
});
