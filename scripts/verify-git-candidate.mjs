#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint } from './build-git-release.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = JSON.parse(
  readFileSync(resolve(root, 'tests/fixtures/git-release-candidate.json'), 'utf8')
);
assert.match(candidate.commit, /^[a-f0-9]{40}$/);
assert.equal(
  sourceFingerprint(root),
  candidate.sourceFingerprint,
  'Git release candidate is stale: regenerate and push a candidate for this runtime source before CI can pass'
);
console.log(candidate.commit);
