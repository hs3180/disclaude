#!/usr/bin/env node
// External package acceptance: run after building a committed checkout.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert(
  process.argv.slice(2).every((arg) => arg === '--matrix'),
  'Only --matrix is supported'
);
const exec = promisify(execFile);
const temp = mkdtempSync(join(tmpdir(), 'disclaude-checkout-install-'));
const distribution = join(temp, 'distribution');
const report = { suite: 'package-install', status: 'preparing', checks: [], cleanup: 'pending' };
let cleanupSafe = true;
function isDockerDeploymentEntry(value) {
  const path = value.replaceAll('\\', '/').replace(/\/$/, '');
  // The Jupyter repair CLI needs this pinned recipe to generate the remote
  // upstream image. It is not a Docker deployment recipe for disclaude itself.
  if (path === 'jupyter/datalayer/Dockerfile') return false;
  const name = path.split('/').at(-1);
  return (
    path === 'docker' ||
    path.startsWith('docker/') ||
    /^docker-compose(?:[.-].*)?\.ya?ml$/u.test(name) ||
    name.startsWith('Dockerfile') ||
    name === 'docker-entrypoint.sh' ||
    name === '.dockerignore'
  );
}

function listDockerDeploymentEntries(root) {
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (isDockerDeploymentEntry(path)) entries.push(path);
      if (item.isDirectory()) visit(join(directory, item.name), path);
    }
  };
  visit(root);
  return entries;
}

function assertDockerDeploymentContract(candidate) {
  const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
  const dockerEntries = (manifest.files || []).filter(isDockerDeploymentEntry);
  assert.deepEqual(
    dockerEntries,
    [],
    'Prebuilt package file list must not advertise source-only Docker assets'
  );
  assert.deepEqual(
    listDockerDeploymentEntries(candidate),
    [],
    'Prebuilt distribution must not contain source-only Docker assets'
  );
  const readme = readFileSync(join(candidate, 'README.md'), 'utf8');
  const guide = readFileSync(join(candidate, 'docs/docker-compose-deployment.md'), 'utf8');
  assert.match(readme, /source-checkout Docker Compose/u);
  assert.match(guide, /full source checkout/u);
  assert.match(guide, /package installed by npm from that tag/u);
}

async function run(command, args, cwd = resolve('.'), timeout = 240_000) {
  try {
    const result = await exec(command, args, { cwd, encoding: 'utf8', timeout });
    return result.stdout;
  } catch (error) {
    // A timeout may leave descendants using the archive. The outer owned-process
    // runner reaps the process group before removing its temporary root.
    if (error.killed || error.signal || error.code === 'ETIMEDOUT') cleanupSafe = false;
    if (error.stdout) console.error(error.stdout);
    if (error.stderr) console.error(error.stderr);
    throw error;
  }
}
try {
  const sourceManifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  assert.deepEqual(
    (sourceManifest.files || []).filter(isDockerDeploymentEntry),
    [],
    'npm files must not advertise source-only Docker assets'
  );
  await run(process.execPath, ['scripts/build-git-release.mjs', distribution]);
  assertDockerDeploymentContract(distribution);
  const provenance = JSON.parse(readFileSync(join(distribution, 'release-source.json'), 'utf8'));
  report.source = provenance;
  const packed = await run('npm', ['pack', '--json', '--ignore-scripts'], distribution, 60_000);
  const packResult = JSON.parse(packed)[0];
  assert.deepEqual(
    packResult.files.filter((file) => isDockerDeploymentEntry(file.path)).map((file) => file.path),
    [],
    'Packed release candidate must not contain source-only Docker assets'
  );
  report.checks.push('candidate release tree and npm archive omit source-only Docker assets');
  const archive = join(distribution, packResult.filename);
  report.status = 'running';
  const output = await run(process.execPath, [
    'scripts/test-package-install.mjs',
    archive,
    provenance.sourceFingerprint,
  ]);
  console.log(output.trim());
  assert(output.includes(`PACKAGE_INSTALL_OK ${provenance.version}`));
  assert(output.includes('CLI_START_STOP_RESTART_OK'));
  assert(output.includes('PACKAGE_TEST_CLEANUP_OK'));
  report.checks.push('current runtime: install, CLI restart, cleanup');
  if (process.argv.includes('--matrix')) {
    const matrix = await run(
      process.execPath,
      ['scripts/test-git-node22.mjs', archive, provenance.sourceFingerprint],
      resolve('.'),
      960_000
    );
    console.log(matrix.trim());
    assert(matrix.includes('Runtime: v22.23.2; npm: 11.6.0'));
    assert(matrix.includes('Runtime: v22.23.2; npm: 10.9.9'));
    assert.equal(matrix.match(/CLI_START_STOP_RESTART_OK/g)?.length, 3);
    assert(matrix.includes(`PACKAGE_INSTALL_OK ${provenance.version}`));
    report.checks.push('Node/npm matrix: install and CLI restart');
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (cleanupSafe) {
    try {
      rmSync(temp, { recursive: true, force: true });
      report.cleanup = 'passed';
    } catch (error) {
      report.cleanup = 'failed';
      report.status = 'failed';
      process.exitCode = 1;
      console.error(error.message);
    }
  } else {
    report.cleanup = 'deferred to owned-process runner';
  }
  if (report.cleanup !== 'passed') report.retainedPath = temp;
  console.log(`PACKAGE_ACCEPTANCE_REPORT ${JSON.stringify(report)}`);
}
