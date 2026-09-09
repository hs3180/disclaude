import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const script = resolve('scripts/validate-release-evidence.mjs');
const source = JSON.parse(readFileSync('tests/e2e/0.5.0/acceptance.json', 'utf8'));
const candidate = 'a'.repeat(40);
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'disclaude-release-evidence-'));
  temporary.push(dir);
  const manifest = structuredClone(source);
  const file = join(dir, 'acceptance.json');
  const run = (mode = '--schema', sha = candidate) => {
    writeFileSync(file, JSON.stringify(manifest));
    return spawnSync(process.execPath, [script, mode, ...(mode === '--gate' ? ['--candidate', sha] : []), file], { encoding: 'utf8' });
  };
  return { dir, manifest, run };
}
function verifyAll(f: ReturnType<typeof fixture>) {
  f.manifest.candidateSha = candidate;
  writeFileSync(join(f.dir, 'artifact.txt'), 'Actual test evidence fixture\n');
  for (const entry of f.manifest.criteria) {
    entry.status = 'verified';
    entry.evidence = (entry.variants ?? ['unit']).map((variant: string) => {
      const name = `${entry.id}-${variant}.json`;
      writeFileSync(join(f.dir, name), JSON.stringify({
        criterion: entry.id, candidateSha: candidate, variant, environment: 'test fixture',
        command: ['node', '--test', 'behavior.test.mjs'], testCases: [entry.requirement],
        exitCode: 0, passed: 1, failed: 0, skipped: 0, expected: 'Expected behavior', observed: 'Observed behavior',
        artifacts: [{ path: 'artifact.txt', sha256: createHash('sha256').update('Actual test evidence fixture\n').digest('hex') }],
      }));
      return name;
    });
  }
}
describe('release evidence inventory gate', () => {
  it('validates the 44-criterion plan without declaring it release-ready', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const result = f.run('--gate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('S01-A1: planned');
    expect(result.stderr).toContain('S09-A4: blocked');
  });
  it('rejects missing, duplicate and unknown acceptance IDs', () => {
    const f = fixture();
    f.manifest.criteria[0].id = 'S01-A2';
    f.manifest.criteria[1].id = 'S99-A1';
    f.manifest.criteria.push(f.manifest.criteria[0]);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Duplicate');
    expect(result.stderr).toContain('Missing S01-A1');
    expect(result.stderr).toContain('Unknown criterion S99-A1');
  });
  it('requires evidence even for schema-mode verified claims', () => {
    const f = fixture();
    f.manifest.criteria[0].status = 'verified';
    expect(f.run().stderr).toContain('verified without evidence');
  });
  it('requires every backend/deployment variant and explicit matching candidate', () => {
    const f = fixture();
    verifyAll(f);
    expect(f.run('--gate').status).toBe(0);
    expect(f.run('--gate', 'b'.repeat(40)).status).toBe(1);
    const entry = f.manifest.criteria.find((item: { id: string }) => item.id === 'S09-A4');
    entry.evidence.pop();
    expect(f.run('--gate').stderr).toContain('no evidence for launchd');
    entry.variants = ['docker'];
    expect(f.run().stderr).toContain('missing required variant launchd');
  });
  it.each(['skipped', 'failed', 'passed', 'exitCode', 'candidateSha', 'command', 'testCases'])('rejects invalid %s evidence', (field) => {
    const f = fixture();
    verifyAll(f);
    const file = join(f.dir, f.manifest.criteria[0].evidence[0]);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    record[field] = field === 'passed' ? 0 : field === 'candidateSha' ? 'b'.repeat(40) : ['command', 'testCases'].includes(field) ? [] : 1;
    writeFileSync(file, JSON.stringify(record));
    expect(f.run('--gate').status).toBe(1);
  });
  it('rejects missing records and altered evidence artifacts', () => {
    const f = fixture();
    verifyAll(f);
    writeFileSync(join(f.dir, 'artifact.txt'), 'changed');
    expect(f.run('--gate').stderr).toContain('changed/empty artifact');
    f.manifest.criteria[0].evidence = ['missing.json'];
    expect(f.run('--gate').stderr).toContain('unreadable evidence');
  });
});
