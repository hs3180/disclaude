import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const matrixPath = resolve(root, 'tests/e2e/0.5.0/matrix.json');
const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));

const requiredSpecs = new Set(['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09']);
const allowedKinds = new Set(['contract', 'integration', 'external', 'release']);
const allowedStatuses = new Set(['implemented', 'planned', 'blocked', 'verified']);
const errors = [];
const ids = new Set();
const seenSpecs = new Set();

if (matrix.release !== '0.5.0') errors.push('matrix.release must be 0.5.0');
if (!matrix.policy?.externalRequiresExplicitOptIn) errors.push('external cases must require explicit opt-in');
if (!matrix.policy?.verifiedRequiresEvidence) errors.push('verified cases must require evidence');
if (!Array.isArray(matrix.cases) || matrix.cases.length === 0) errors.push('cases must be a non-empty array');

for (const testCase of matrix.cases ?? []) {
  if (!testCase.id || ids.has(testCase.id)) errors.push(`duplicate or missing case id: ${testCase.id ?? '<missing>'}`);
  ids.add(testCase.id);
  if (!requiredSpecs.has(testCase.spec)) errors.push(`${testCase.id}: unknown or missing spec`);
  seenSpecs.add(testCase.spec);
  if (!allowedKinds.has(testCase.kind)) errors.push(`${testCase.id}: invalid kind`);
  if (!allowedStatuses.has(testCase.status)) errors.push(`${testCase.id}: invalid status`);
  if (!testCase.title || !testCase.command) errors.push(`${testCase.id}: title and command are required`);
  if (testCase.kind === 'external' && testCase.status === 'verified' && !testCase.evidence) {
    errors.push(`${testCase.id}: verified external case requires evidence`);
  }
}

for (const spec of requiredSpecs) {
  if (!seenSpecs.has(spec)) errors.push(`missing coverage for ${spec}`);
}

if (errors.length) {
  console.error(`E2E matrix invalid (${errors.length} error(s))`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const counts = Object.fromEntries([...allowedStatuses].map((status) => [
  status,
  matrix.cases.filter((testCase) => testCase.status === status).length,
]));
console.log(`E2E matrix valid: ${matrix.cases.length} cases across ${seenSpecs.size} specs`);
console.log(`Status: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ')}`);
