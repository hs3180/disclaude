/**
 * Audit the complete S01–S09 evidence inventory; this does not execute behavior tests.
 * node scripts/validate-release-evidence.mjs --schema [manifest]
 * node scripts/validate-release-evidence.mjs --gate --candidate <full SHA> [manifest]
 * Evidence paths are relative to the manifest. Each JSON record requires criterion,
 * candidateSha, variant (when required), environment, command (argv), testCases,
 * exitCode: 0, passed > 0, failed: 0, skipped: 0, expected, observed, and artifacts.
 * Each artifact has path (relative to record) and sha256. Records and artifacts
 * remain local until sanitized; no token, provider credential or private log is committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const gate = args.shift();
let candidate;
if (args[0] === '--candidate') { args.shift(); candidate = args.shift(); }
const manifestPath = path.resolve(args.shift() ?? 'tests/e2e/0.5.0/acceptance.json');
const errors = [];
const requireThat = (condition, message) => { if (!condition) errors.push(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const required = [4, 5, 5, 5, 5, 5, 5, 4, 6].flatMap((count, index) =>
  Array.from({ length: count }, (_, a) => `S${String(index + 1).padStart(2, '0')}-A${a + 1}`));
const requiredVariants = {
  'S01-A4': ['claude', 'codex', 'pi'], 'S02-A4': ['deepseek'],
  'S08-A4': ['docker', 'launchd'], 'S09-A2': ['claude', 'codex', 'pi', 'deepseek'],
  'S09-A4': ['docker', 'launchd'],
};

try {
  requireThat(['--schema', '--gate'].includes(gate) && args.length === 0, 'Usage: --schema [manifest] or --gate --candidate <SHA> [manifest]');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  requireThat(manifest.version === 1 && Array.isArray(manifest.criteria), 'Invalid manifest version/criteria');
  const entries = Array.isArray(manifest.criteria) ? manifest.criteria : [];
  requireThat(entries.length === required.length, `Exactly ${required.length} criteria are required`);
  const ids = entries.map(entry => entry?.id);
  requireThat(new Set(ids).size === ids.length, 'Duplicate criterion IDs');
  for (const id of required) requireThat(ids.includes(id), `Missing ${id}`);
  if (gate === '--gate') {
    requireThat(sha(candidate), '--gate requires an explicit full candidate SHA');
    requireThat(manifest.candidateSha === candidate && sha(manifest.candidateSha), 'Manifest candidate SHA is missing or stale');
  }
  for (const entry of entries) {
    const id = entry?.id;
    requireThat(required.includes(id), `Unknown criterion ${id}`);
    requireThat(nonempty(entry.requirement), `${id}: missing requirement`);
    requireThat(['planned', 'blocked', 'verified'].includes(entry.status), `${id}: invalid status`);
    requireThat(Array.isArray(entry.evidence), `${id}: evidence must be an array`);
    requireThat(entry.variants === undefined || (Array.isArray(entry.variants) && entry.variants.every(nonempty) && new Set(entry.variants).size === entry.variants.length), `${id}: variants must be unique nonempty strings`);
    for (const variant of requiredVariants[id] ?? []) requireThat(entry.variants?.includes(variant), `${id}: missing required variant ${variant}`);
    if (gate === '--gate') requireThat(entry.status === 'verified', `${id}: ${entry.status}`);
    if (entry.status !== 'verified') continue;
    requireThat(sha(manifest.candidateSha), `${id}: verified requires candidate SHA`);
    requireThat(entry.evidence?.length > 0, `${id}: verified without evidence`);
    const observedVariants = new Set();
    for (const file of entry.evidence ?? []) {
      try {
        const recordPath = path.resolve(path.dirname(manifestPath), file);
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        requireThat(record.criterion === id && record.candidateSha === manifest.candidateSha, `${id}: stale/misattributed evidence ${file}`);
        requireThat(record.exitCode === 0 && Number.isInteger(record.passed) && record.passed > 0 && record.failed === 0 && record.skipped === 0, `${id}: failed, empty or skipped checks ${file}`);
        for (const key of ['environment', 'expected', 'observed']) requireThat(nonempty(record[key]), `${id}: missing ${key} in ${file}`);
        for (const key of ['command', 'testCases']) requireThat(Array.isArray(record[key]) && record[key].length > 0 && record[key].every(nonempty), `${id}: missing ${key} in ${file}`);
        requireThat(Array.isArray(record.artifacts) && record.artifacts.length > 0, `${id}: missing artifacts ${file}`);
        for (const artifact of record.artifacts ?? []) {
          const bytes = fs.readFileSync(path.resolve(path.dirname(recordPath), artifact.path));
          requireThat(bytes.length > 0 && crypto.createHash('sha256').update(bytes).digest('hex') === artifact.sha256, `${id}: missing/changed/empty artifact ${artifact.path}`);
        }
        observedVariants.add(record.variant);
      } catch (error) { errors.push(`${id}: unreadable evidence ${file}: ${error.message}`); }
    }
    for (const variant of new Set([...(requiredVariants[id] ?? []), ...(Array.isArray(entry.variants) ? entry.variants : [])])) requireThat(observedVariants.has(variant), `${id}: no evidence for ${variant}`);
  }
} catch (error) { errors.push(error.message); }
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(gate === '--schema' ? 'SCHEMA_VALID (not release readiness)' : 'EVIDENCE_INVENTORY_VALID (review behavioral evidence before release)');
}
