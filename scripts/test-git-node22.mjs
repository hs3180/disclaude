#!/usr/bin/env node
// Complete the Node 20/22 × npm 10/11 matrix through the existing CI job.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'disclaude-node22-gate-'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 240_000, ...options });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
// Isolated tooling only: do not upgrade the runner's or user's Node/npm.
run(
  'npm',
  [
    'install',
    '--global=false',
    '--prefix',
    temp,
    '--no-audit',
    '--no-fund',
    'node@22.23.2',
    'npm@11.6.0',
  ],
  { cwd: temp }
);
const bin = join(temp, 'node_modules/.bin');
const npm10 = join(temp, 'npm10');
run('npm', ['install', '--global=false', '--prefix', npm10, '--no-audit', '--no-fund', 'npm@10.9.9'], { cwd: temp });
const pairs = [
  [join(bin, 'node'), join(temp, 'node_modules/npm/bin/npm-cli.js')],
  [process.execPath, join(temp, 'node_modules/npm/bin/npm-cli.js')],
  [join(bin, 'node'), join(npm10, 'node_modules/npm/bin/npm-cli.js')],
];
for (const [index, [node, npm]] of pairs.entries()) {
  // Select both executables explicitly; no dependence on the runner's npm symlink.
  const selected = join(temp, `pair-${index}`);
  mkdirSync(selected);
  symlinkSync(node, join(selected, 'node'));
  symlinkSync(npm, join(selected, 'npm'));
  console.log(run(node, [resolve('scripts/test-package-install.mjs'), process.argv[2], process.argv[3], '--prefix-from-env'], {
    env: { ...process.env, PATH: `${selected}${delimiter}${process.env.PATH}` },
  }));
}
rmSync(temp, { recursive: true });
