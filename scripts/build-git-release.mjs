#!/usr/bin/env node
// Generate a prebuilt Git distribution; never mutate the development manifest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function sourceFingerprint(root) {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      'package.json',
      'package-lock.json',
      'tsconfig*.json',
      'packages/*/src/**',
      'packages/*/package.json',
      'packages/*/tsconfig.json',
      'bin',
      'skills',
      'agents',
      '.claude-plugin',
      'examples/skills',
      'disclaude.config.example.yaml',
      'scripts/build-git-release.mjs',
      'scripts/prune-build-artifacts.mjs',
      'scripts/launchd.mjs',
    ],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\0')
    .filter((file) => file && !/\.(test|spec)\.[cm]?[jt]s$/.test(file))
    .sort();
  const hash = createHash('sha256');
  for (const file of files)
    hash
      .update(file + '\0')
      .update(readFileSync(join(root, file)))
      .update('\0');
  return hash.digest('hex');
}

export function rewriteImports(code, file, targets) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function visit(node) {
    const spec =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    if (spec && ts.isStringLiteral(spec) && spec.text.startsWith('@disclaude/')) {
      assert(targets[spec.text], `Unknown internal import: ${spec.text}`);
      let target = relative(dirname(file), targets[spec.text]).split('\\').join('/');
      if (!target.startsWith('.')) target = './' + target;
      edits.push([spec.getStart(source), spec.end, JSON.stringify(target)]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0]))
    code = code.slice(0, start) + value + code.slice(end);
  return code.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
}

export function generateRelease(root, output) {
  assert(!existsSync(output) || readdirSync(output).length === 0, 'Output must be new or empty');
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const pkg = json(join(root, 'package.json'));
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    '',
    'Build from a committed source tree'
  );
  mkdirSync(output, { recursive: true });
  const names = ['core', 'service', 'channel-cli'];
  const targets = Object.fromEntries(
    names.map((name) => [`@disclaude/${name}`, join(output, 'packages', name, 'dist/index.js')])
  );
  const dependencies = {};
  for (const manifest of [
    pkg,
    ...names.map((name) => json(join(root, 'packages', name, 'package.json'))),
  ]) {
    for (const [name, version] of Object.entries(manifest.dependencies || {})) {
      if (targets[name]) continue;
      assert(!name.startsWith('@disclaude/'), `Unresolved workspace dependency: ${name}`);
      assert(
        !dependencies[name] || dependencies[name] === version,
        `Conflicting dependency: ${name}`
      );
      dependencies[name] = version;
    }
  }
  for (const name of names) {
    const source = join(root, 'packages', name, 'dist');
    assert(existsSync(join(source, 'index.js')), 'Run npm ci and npm run build first');
    cpSync(source, join(output, 'packages', name, 'dist'), {
      recursive: true,
      filter: (path) => !/\.(?:test|spec)\.|\.map$|\.d\.ts$/.test(path),
    });
  }
  // Explicit allowlist: never copy credentials, node_modules or local workspace.
  for (const path of [
    'bin',
    'skills',
    'agents',
    '.claude-plugin',
    'examples/skills',
    'docs',
    'README.md',
    'LICENSE',
    'disclaude.config.example.yaml',
    'scripts/launchd.mjs',
  ]) {
    if (!existsSync(join(root, path))) continue;
    mkdirSync(dirname(join(output, path)), { recursive: true });
    const tracked = execFileSync('git', ['ls-files', '-z', '--', path], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
    for (const file of tracked) {
      assert(
        !lstatSync(join(root, file)).isSymbolicLink(),
        `Release resources must not be symlinks: ${file}`
      );
      mkdirSync(dirname(join(output, file)), { recursive: true });
      cpSync(join(root, file), join(output, file));
    }
  }
  function rewriteTree(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) rewriteTree(path);
      else if (/\.[cm]?js$/.test(entry.name)) {
        const code = rewriteImports(readFileSync(path, 'utf8'), path, targets).replaceAll(
          'node_modules/@disclaude/',
          'packages/'
        );
        writeFileSync(path, code);
      }
    }
  }
  for (const dir of ['packages', 'bin', 'scripts']) rewriteTree(join(output, dir));
  const manifest = Object.fromEntries(
    [
      'name',
      'version',
      'description',
      'private',
      'type',
      'bin',
      'repository',
      'homepage',
      'license',
    ]
      .filter((key) => pkg[key] !== undefined)
      .map((key) => [key, pkg[key]])
  );
  Object.assign(manifest, {
    engines: { node: '>=20.0.0', npm: '>=10.0.0' },
    dependencies,
    files: [
      'bin/',
      'packages/',
      'scripts/',
      'skills/',
      'agents/',
      '.claude-plugin/',
      'examples/',
      'docs/',
      'disclaude.config.example.yaml',
      'release-source.json',
    ],
  });
  writeFileSync(join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(
    join(output, 'release-source.json'),
    JSON.stringify(
      {
        sourceCommit,
        sourceFingerprint: sourceFingerprint(root),
        version: pkg.version,
        generator: 'scripts/build-git-release.mjs',
      },
      null,
      2
    ) + '\n'
  );
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], 'Usage: node scripts/build-git-release.mjs <empty-output-directory>');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  generateRelease(root, resolve(process.argv[2]));
  console.log(`Git release generated in ${resolve(process.argv[2])}`);
}
