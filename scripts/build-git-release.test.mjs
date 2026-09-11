import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteImports } from './build-git-release.mjs';

test('rewrites static, re-export and dynamic internal imports only', () => {
  const code = `import { x } from '@disclaude/core';\nexport * from '@disclaude/core';\nawait import('@disclaude/core');\nconst message = '@disclaude/core';\nimport fs from 'node:fs';`;
  const result = rewriteImports(code, '/out/packages/primary-node/dist/nested/file.js', {
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
