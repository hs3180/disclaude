// Generator unit tests using temporary source fixtures. Actual installation and
// service startup are exercised separately by the package-install CI job.
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { rewriteImports, generateRelease, sourceFingerprint } from '../scripts/build-git-release.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); }
});

test('rewrites static, re-export and dynamic internal imports only', () => {
  const code = `import { x } from '@disclaude/core';\nexport * from '@disclaude/core';\nawait import('@disclaude/core');\nconst message = '@disclaude/core';\nimport fs from 'node:fs';`;
  const result = rewriteImports(code, '/out/packages/service/dist/nested/file.js', {
    '@disclaude/core': '/out/packages/core/dist/index.js',
  });
  assert.equal((result.match(/\.\.\/\.\.\/\.\.\/core\/dist\/index.js/g) || []).length, 3);
  assert(result.includes("const message = '@disclaude/core'"));
  assert(result.includes("from 'node:fs'"));
});

test('fails closed on unknown internal imports', () => {
  assert.throws(
    () => rewriteImports("import '@disclaude/missing';", '/out/file.js', {}),
    /Unknown internal import/
  );
});

test('generates a standalone manifest and excludes untracked resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-release-unit-'));
  roots.push(root);
  const write = (file: string, data: string) => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), data);
  };
  write(
    'package.json',
    JSON.stringify({
      name: 'disclaude',
      version: '0.5.1',
      type: 'module',
      private: true,
      workspaces: ['packages/*'],
      scripts: { prepare: 'husky', build: 'tsc' },
      devDependencies: { husky: '9.1.7' },
      dependencies: { '@disclaude/core': '*' },
    })
  );
  write('README.md', '# Release README');
  write('.gitignore', 'packages/*/dist/\n**/*.tsbuildinfo\n');
  write('tsconfig.json', JSON.stringify({
    files: [], references: ['core', 'service', 'channel-cli'].map((name) => ({ path: `packages/${name}` })),
  }));
  write('CHANGELOG.md', '# Release changelog');
  write('bin/disclaude.js', "const route = 'node_modules/@disclaude/service/dist/cli.js';");
  write('scripts/launchd.mjs', "import './chromium-config.mjs';");
  write('scripts/chromium-config.mjs', 'export {};');
  write('scripts/chromium-diagnose.mjs', 'export const readOnly = true;');
  write('skills/example/SKILL.md', 'tracked skill');
  write('optional-plugins/diagnostics/skills/diagnose-logs/SKILL.md', 'optional skill');
  write('optional-plugins/diagnostics/.claude-plugin/plugin.json', '{"name":"disclaude-diagnostics"}');
  write('scripts/browser-use-smoke.sh', '#!/bin/bash\nexit 0');
  write('scripts/browser-use-smoke-daemon.py', 'pass');
  write('scripts/browser-use-smoke-timeout.py', 'pass');
  write('.claude-plugin/plugin.json', '{"name":"builtins"}');
  write('agents/example.md', 'builtin agent');
  write('docker/start-chromium.sh', '#!/bin/bash\nexit 0');
  write('docker-compose.yml', 'services: {}');
  write('jupyter/datalayer/Dockerfile', 'FROM configured-existing-image');
  write('jupyter/datalayer/runtime.py', '# optional remote runtime');
  write('jupyter/datalayer/README.md', '# Remote overlay from a full source checkout');
  for (const name of ['core', 'service', 'channel-cli']) {
    write(`packages/${name}/tsconfig.json`, JSON.stringify({
      compilerOptions: { composite: true, target: 'ES2022', module: 'ES2022', moduleResolution: 'Bundler', rootDir: 'src', outDir: 'dist' },
      include: ['src/**/*.ts'],
    }));
    write(
      `packages/${name}/package.json`,
      JSON.stringify({
        dependencies: {
          'js-yaml': '^4.1.0',
          ...(name === 'core' ? {} : { '@disclaude/core': '*' }),
        },
      })
    );
    write(
      `packages/${name}/dist/index.js`,
      name === 'core' ? 'export const x = 1;' : "export { x } from '@disclaude/core'; import '@disclaude/core/secret-environment';"
    );
    write(`packages/${name}/src/index.ts`, '// @ts-nocheck\n' + (name === 'core'
      ? 'export const x = 1;'
      : "export { x } from '@disclaude/core'; import '@disclaude/core/secret-environment';"));
    write(`packages/${name}/dist/index.test.js`, 'should not ship');
  }
  write('packages/core/dist/config/secret-environment.js', 'export const names = new Set();');
  write('packages/core/src/config/secret-environment.ts', 'export const names = new Set();');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root });
  git(['init', '-q']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Release Test',
    '-c',
    'user.email=release-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  ]);
  write('skills/example/private.txt', 'untracked secret');
  const output = join(root, 'output');
  const manifest = generateRelease(root, output);
  assert.equal(manifest.workspaces, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.deepEqual(manifest.dependencies, { 'js-yaml': '^4.1.0' });
  assert(!existsSync(join(output, 'skills/example/private.txt')));
  assert(!existsSync(join(output, 'skills/diagnose-logs/SKILL.md')));
  assert(existsSync(join(output, 'optional-plugins/diagnostics/skills/diagnose-logs/SKILL.md')));
  assert(manifest.files.includes('optional-plugins/'));
  assert(existsSync(join(output, '.claude-plugin/plugin.json')));
  for (const file of ['browser-use-smoke.sh', 'browser-use-smoke-daemon.py', 'browser-use-smoke-timeout.py']) {
    assert(existsSync(join(output, 'scripts', file)));
  }
  assert(existsSync(join(output, 'agents/example.md')));
  assert.equal(readFileSync(join(output, 'README.md'), 'utf8'), '# Release README');
  assert.equal(readFileSync(join(output, 'CHANGELOG.md'), 'utf8'), '# Release changelog');
  assert(manifest.files.includes('README.md'));
  assert(manifest.files.includes('CHANGELOG.md'));
  assert(existsSync(join(output, 'scripts/chromium-config.mjs')));
  assert(existsSync(join(output, 'scripts/chromium-diagnose.mjs')));
  assert(!existsSync(join(output, 'packages/core/dist/index.test.js')));
  assert(!existsSync(join(output, 'docker/start-chromium.sh')));
  assert(!existsSync(join(output, 'docker-compose.yml')));
  assert(!existsSync(join(output, 'jupyter/datalayer/Dockerfile')));
  assert(existsSync(join(output, 'jupyter/datalayer/runtime.py')));
  assert(existsSync(join(output, 'jupyter/datalayer/README.md')));
  assert(!manifest.files.includes('docker/'));
  assert(!existsSync(join(output, 'packages/core/package.json')));
  assert.match(
    readFileSync(join(output, 'packages/service/dist/index.js'), 'utf8'),
    /\.\.\/\.\.\/core\/dist\/index.js/
  );
  assert.match(readFileSync(join(output, 'packages/service/dist/index.js'), 'utf8'),
    /\.\.\/\.\.\/core\/dist\/config\/secret-environment.js/);
  assert.equal(
    JSON.parse(readFileSync(join(output, 'release-source.json'), 'utf8')).sourceFingerprint,
    sourceFingerprint(root)
  );
  const provenance = JSON.parse(readFileSync(join(output, 'release-source.json'), 'utf8'));
  assert.equal(provenance.build.command, 'tsc --build --force');
  assert.match(provenance.build.runtimeFingerprint, /^[a-f0-9]{64}$/);

  // Reproduce #5517: advance committed source while leaving old dist and build
  // state in place. The shipped runtime must execute the new implementation.
  write('packages/core/src/index.ts', 'export const x = 2;');
  git(['add', 'packages/core/src/index.ts']);
  git(['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'new implementation without rebuilding']);
  assert.match(readFileSync(join(root, 'packages/core/dist/index.js'), 'utf8'), /x = 1/);
  const refreshed = join(root, 'refreshed');
  generateRelease(root, refreshed);
  const actual = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { x } from ${JSON.stringify(join(refreshed, 'packages/core/dist/index.js'))}; console.log(x);`], { encoding: 'utf8' });
  assert.equal(actual.trim(), '2');
  const refreshedProvenance = JSON.parse(readFileSync(join(refreshed, 'release-source.json'), 'utf8'));
  assert.notEqual(refreshedProvenance.build.runtimeFingerprint, provenance.build.runtimeFingerprint);
  assert.throws(() => generateRelease(root, output), /new or empty/);
  write('skills/diagnose-logs/SKILL.md', 'accidental default plugin');
  assert.throws(() => generateRelease(root, join(root, 'contaminated')), /outside the default/);
  rmSync(join(root, 'skills/diagnose-logs'), { recursive: true });
  write('bin/disclaude.js', 'changed');
  assert.throws(() => generateRelease(root, join(root, 'other')), /committed source tree/);
});

test('release provenance fingerprint follows docs, dependency lock and workspace settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-release-doc-fingerprint-'));
  roots.push(root);
  writeFileSync(join(root, 'README.md'), '# Initial README');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Initial changelog');
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*']\n");
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'README.md', 'CHANGELOG.md', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], { cwd: root });

  let fingerprint = sourceFingerprint(root);
  for (const file of ['README.md', 'CHANGELOG.md', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8') + '\n# Changed');
    const next = sourceFingerprint(root);
    assert.notEqual(next, fingerprint, `${file} must affect release provenance`);
    fingerprint = next;
  }
});


test('fingerprint includes nested runtime source across packages but excludes test-only changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-fingerprint-source-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const name of ['core', 'service', 'channel-cli']) {
      const directory = join(root, 'packages', name, 'src', 'nested');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'runtime.ts'), 'export const version = 1;');
      writeFileSync(join(directory, 'runtime.test.ts'), '// fixture');
    }
    execFileSync('git', ['add', '.'], { cwd: root });
    for (const name of ['core', 'service', 'channel-cli']) {
      const before = sourceFingerprint(root);
      writeFileSync(join(root, 'packages', name, 'src', 'nested', 'runtime.ts'), 'export const version = 2;');
      assert.notEqual(sourceFingerprint(root), before, `${name} runtime must invalidate a stale candidate`);
    }
    const beforeTestChange = sourceFingerprint(root);
    writeFileSync(join(root, 'packages/core/src/nested/runtime.test.ts'), '// changed fixture');
    assert.equal(sourceFingerprint(root), beforeTestChange);
  } finally {rmSync(root, { recursive: true, force: true });}
});
