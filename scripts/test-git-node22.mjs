#!/usr/bin/env node
// Run the second supported runtime pair through the existing CI test job.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
const output = run(
  join(bin, 'node'),
  [
    resolve('scripts/test-package-install.mjs'),
    process.argv[2],
    process.argv[3],
    '--prefix-from-env',
  ],
  { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } }
);
console.log(output);
rmSync(temp, { recursive: true });
