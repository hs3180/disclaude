#!/usr/bin/env node
// Test a built archive, never a symlink to the developer checkout. No live API calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const archive = resolve(process.argv[2] || '');
assert(process.argv[2]?.endsWith('.tgz') && existsSync(archive), 'Pass an existing .tgz archive');
const temp = mkdtempSync(join(tmpdir(), 'disclaude-package-test-'));
const prefix = join(temp, 'prefix');
const env = { ...process.env, NODE_ENV: 'production' };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
for (const key of Object.keys(env)) {
  if (/^npm_config_/i.test(key)) delete env[key];
}
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: temp,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.error || ''}\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}
console.log(`Isolated installation evidence: ${temp}`);
run('npm', [
  'install',
  '-g',
  '--prefix',
  prefix,
  '--cache',
  join(temp, 'cache'),
  '--userconfig',
  join(temp, 'empty.npmrc'),
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  archive,
]);
const installed = join(prefix, 'lib/node_modules/disclaude');
assert(
  realpathSync(installed).startsWith(realpathSync(prefix) + sep),
  'Package must not link to a temporary clone'
);
const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
assert.equal(pkg.scripts.prepare, undefined, 'User installation must not initialize Git hooks');
assert(!existsSync(join(installed, 'node_modules/husky')), 'Husky must remain development-only');
assert(existsSync(join(installed, 'disclaude.config.example.yaml')));
const cli = join(prefix, 'bin/disclaude');
assert.equal(run(cli, ['--version']).trim(), `disclaude v${pkg.version}`);
assert.match(run(cli, ['start', '--help']), /Usage:/i);
assert.match(run(cli, ['channel', '--help']), /Usage:/i);
assert.match(run(join(prefix, 'bin/disclaude-primary'), ['--help']), /Usage:/i);
// Loading the installed modules catches missing transitive SDK dependencies that
// --version alone cannot detect. Resolve relative to the installed distribution.
run(process.execPath, [
  '--input-type=module',
  '-e',
  `
  import { join } from 'node:path';
  import { pathToFileURL } from 'node:url';
  const installed = ${JSON.stringify(installed)};
  for (const name of ['@disclaude/core', '@disclaude/primary-node', '@disclaude/channel-cli']) {
    await import(pathToFileURL(join(installed, 'node_modules', name, 'dist/index.js')).href);
  }
  process.exit(0);
`,
]);
console.log(`PACKAGE_INSTALL_OK ${pkg.version}`);
