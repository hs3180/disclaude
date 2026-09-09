/**
 * Audit trusted-runner S01–S09 evidence structure and integrity. This does not
 * execute tests or establish that arbitrary evidence text is truthful.
 * node scripts/validate-release-evidence.mjs --schema [manifest]
 * node scripts/validate-release-evidence.mjs --gate --candidate <full SHA> [manifest]
 * The manifest must be under the repository evidence root; evidence paths are
 * relative and may not escape it through traversal, absolute paths, or symlinks.
 * Each JSON record requires criterion,
 * candidateSha, variant (when required), environment, command (argv), testCases,
 * exitCode: 0, passed > 0, failed: 0, skipped: 0, expected, observed, and artifacts.
 * Each artifact has path (relative to record) and sha256. Records and artifacts
 * remain local until sanitized; no token, provider credential or private log is committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const gate = args.shift();
let candidate;
if (args[0] === '--candidate') {
  args.shift();
  candidate = args.shift();
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = path.join(repoRoot, 'tests/e2e/0.5.0');
const manifestArgument = args.shift() ?? 'tests/e2e/0.5.0/acceptance.json';
const errors = [];
const requireThat = (condition, message) => {
  if (!condition) errors.push(message);
};
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const canonicalManifestRepoPath = 'tests/e2e/0.5.0/acceptance.json';
const required = [4, 5, 5, 5, 5, 5, 5, 4, 6].flatMap((count, index) =>
  Array.from(
    { length: count },
    (_, acceptanceIndex) => `S${String(index + 1).padStart(2, '0')}-A${acceptanceIndex + 1}`
  )
);
const isWithin = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const resolveEvidencePath = (base, relativePath, label) => {
  if (!nonempty(relativePath) || path.isAbsolute(relativePath))
    throw new Error(`${label}: path must be relative`);
  const resolved = path.resolve(base, relativePath);
  if (!isWithin(evidenceRoot, resolved)) throw new Error(`${label}: path escapes evidence root`);
  const real = fs.realpathSync(resolved);
  if (!isWithin(evidenceRoot, real)) throw new Error(`${label}: symlink escapes evidence root`);
  return real;
};
const git = (...gitArgs) => spawnSync('git', ['-C', repoRoot, ...gitArgs], { encoding: 'utf8' });
const readCanonical = (revision) => {
  const result = git('show', `${revision}:${canonicalManifestRepoPath}`);
  if (result.status !== 0) throw new Error(`Cannot read canonical criteria at ${revision}`);
  return JSON.parse(result.stdout);
};

try {
  requireThat(
    ['--schema', '--gate'].includes(gate) && args.length === 0,
    'Usage: --schema [manifest] or --gate --candidate <SHA> [manifest]'
  );
  requireThat(
    !path.isAbsolute(manifestArgument),
    'Manifest path must be relative to the repository'
  );
  const manifestPath = resolveEvidencePath(repoRoot, manifestArgument, 'manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (gate === '--gate') {
    requireThat(sha(candidate), '--gate requires an explicit full candidate SHA');
    const candidateExists =
      sha(candidate) && git('cat-file', '-e', `${candidate}^{commit}`).status === 0;
    requireThat(candidateExists, 'Candidate SHA is not a commit in the current repository');
  }
  const canonical = readCanonical('HEAD');
  const canonicalEntries = Array.isArray(canonical?.criteria) ? canonical.criteria : [];
  const canonicalById = new Map(canonicalEntries.map((entry) => [entry.id, entry]));
  requireThat(
    canonicalEntries.length === required.length && required.every((id) => canonicalById.has(id)),
    'Repository canonical acceptance inventory is incomplete'
  );
  const requiredVariants = Object.fromEntries(
    canonicalEntries.map((entry) => [entry.id, entry.variants ?? []])
  );
  requireThat(
    manifest.version === 1 && Array.isArray(manifest.criteria),
    'Invalid manifest version/criteria'
  );
  const entries = Array.isArray(manifest.criteria) ? manifest.criteria : [];
  requireThat(
    entries.length === required.length,
    `Exactly ${required.length} criteria are required`
  );
  const ids = entries.map((entry) => entry?.id);
  requireThat(new Set(ids).size === ids.length, 'Duplicate criterion IDs');
  for (const id of required) requireThat(ids.includes(id), `Missing ${id}`);
  if (gate === '--gate') {
    requireThat(sha(candidate), '--gate requires an explicit full candidate SHA');
    requireThat(
      manifest.candidateSha === candidate && sha(manifest.candidateSha),
      'Manifest candidate SHA is missing or stale'
    );
  }
  for (const entry of entries) {
    const id = entry?.id;
    requireThat(required.includes(id), `Unknown criterion ${id}`);
    const canonicalEntry = canonicalById.get(id);
    requireThat(
      entry.requirement === canonicalEntry?.requirement,
      `${id}: requirement differs from canonical release inventory`
    );
    requireThat(['planned', 'blocked', 'verified'].includes(entry.status), `${id}: invalid status`);
    requireThat(Array.isArray(entry.evidence), `${id}: evidence must be an array`);
    requireThat(
      entry.variants === undefined ||
        (Array.isArray(entry.variants) &&
          entry.variants.every(nonempty) &&
          new Set(entry.variants).size === entry.variants.length),
      `${id}: variants must be unique nonempty strings`
    );
    const variants = entry.variants ?? [];
    requireThat(
      JSON.stringify(variants) === JSON.stringify(requiredVariants[id] ?? []),
      `${id}: variants differ from canonical release inventory`
    );
    if (gate === '--gate') requireThat(entry.status === 'verified', `${id}: ${entry.status}`);
    if (entry.status !== 'verified') continue;
    requireThat(sha(manifest.candidateSha), `${id}: verified requires candidate SHA`);
    requireThat(entry.evidence?.length > 0, `${id}: verified without evidence`);
    const observedVariants = new Set();
    for (const file of entry.evidence ?? []) {
      try {
        const recordPath = resolveEvidencePath(
          path.dirname(manifestPath),
          file,
          `${id}: evidence ${file}`
        );
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        requireThat(
          record.criterion === id && record.candidateSha === manifest.candidateSha,
          `${id}: stale/misattributed evidence ${file}`
        );
        requireThat(
          record.exitCode === 0 &&
            Number.isInteger(record.passed) &&
            record.passed > 0 &&
            record.failed === 0 &&
            record.skipped === 0,
          `${id}: failed, empty or skipped checks ${file}`
        );
        for (const key of ['environment', 'expected', 'observed'])
          requireThat(nonempty(record[key]), `${id}: missing ${key} in ${file}`);
        for (const key of ['command', 'testCases'])
          requireThat(
            Array.isArray(record[key]) && record[key].length > 0 && record[key].every(nonempty),
            `${id}: missing ${key} in ${file}`
          );
        requireThat(
          Array.isArray(record.artifacts) && record.artifacts.length > 0,
          `${id}: missing artifacts ${file}`
        );
        for (const artifact of record.artifacts ?? []) {
          const artifactPath = resolveEvidencePath(
            path.dirname(recordPath),
            artifact.path,
            `${id}: artifact ${artifact.path}`
          );
          const bytes = fs.readFileSync(artifactPath);
          requireThat(
            bytes.length > 0 &&
              crypto.createHash('sha256').update(bytes).digest('hex') === artifact.sha256,
            `${id}: missing/changed/empty artifact ${artifact.path}`
          );
        }
        observedVariants.add(record.variant);
      } catch (error) {
        errors.push(`${id}: unreadable evidence ${file}: ${error.message}`);
      }
    }
    for (const variant of requiredVariants[id] ?? [])
      requireThat(observedVariants.has(variant), `${id}: no evidence for ${variant}`);
  }
} catch (error) {
  errors.push(error.message);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    gate === '--schema'
      ? 'SCHEMA_VALID (not release readiness)'
      : 'EVIDENCE_INVENTORY_VALID (review behavioral evidence before release)'
  );
}
