import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteImports, generateRelease, sourceFingerprint } from './build-git-release.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  const write = (file, data) => {
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
  write('bin/disclaude.js', "const route = 'node_modules/@disclaude/service/dist/cli.js';");
  write('scripts/launchd.mjs', 'export {};');
  write('skills/example/SKILL.md', 'tracked skill');
  write('.claude-plugin/plugin.json', '{"name":"builtins"}');
  write('agents/example.md', 'builtin agent');
  for (const name of ['core', 'service', 'channel-cli']) {
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
      name === 'core' ? 'export const x = 1;' : "export { x } from '@disclaude/core';"
    );
    write(`packages/${name}/dist/index.test.js`, 'should not ship');
  }
  const git = (args) => execFileSync('git', args, { cwd: root });
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
  assert(existsSync(join(output, '.claude-plugin/plugin.json')));
  assert(existsSync(join(output, 'agents/example.md')));
  assert(!existsSync(join(output, 'packages/core/dist/index.test.js')));
  assert(!existsSync(join(output, 'packages/core/package.json')));
  assert.match(
    readFileSync(join(output, 'packages/service/dist/index.js'), 'utf8'),
    /\.\.\/\.\.\/core\/dist\/index.js/
  );
  assert.equal(
    JSON.parse(readFileSync(join(output, 'release-source.json'))).sourceFingerprint,
    sourceFingerprint(root)
  );
  assert.throws(() => generateRelease(root, output), /new or empty/);
  write('bin/disclaude.js', 'changed');
  assert.throws(() => generateRelease(root, join(root, 'other')), /committed source tree/);
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
