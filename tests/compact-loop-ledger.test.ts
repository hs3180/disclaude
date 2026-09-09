import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const script = resolve('scripts/compact-loop-ledger.mjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(rounds = 8) {
  const dir = mkdtempSync(join(tmpdir(), 'disclaude-ledger-'));
  dirs.push(dir);
  const file = join(dir, 'STATE.md');
  const prefix = '# Current state\nKeep all constraints.\n\n';
  const blocks = Array.from({ length: rounds }, (_, i) => `## Round ${i + 1}\n第 ${i + 1} 轮的完整证据\n\n`);
  const original = prefix + blocks.join('');
  writeFileSync(file, original);
  const run = (...args: string[]) => spawnSync(process.execPath, [script, '--file', file, ...args], { encoding: 'utf8' });
  return { dir, file, prefix, blocks, original, run };
}
describe('bounded loop ledger compaction', () => {
  it('defaults to dry-run without filesystem changes', () => {
    const f = fixture();
    const result = f.run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).archivedRounds).toEqual([1, 2, 3]);
    expect(readFileSync(f.file, 'utf8')).toBe(f.original);
    expect(readdirSync(f.dir)).toEqual(['STATE.md']);
  });
  it('preserves every byte across 72 rounds and is idempotent after apply', () => {
    const f = fixture(72);
    expect(f.run('--apply').status).toBe(0);
    const archived = readdirSync(f.file + '.archive').sort().map(name => readFileSync(join(f.file + '.archive', name), 'utf8')).join('');
    const active = readFileSync(f.file, 'utf8');
    expect(active).toBe(f.prefix + f.blocks.slice(-5).join(''));
    expect(f.prefix + archived + active.slice(f.prefix.length)).toBe(f.original);
    expect(JSON.parse(f.run('--apply').stdout).archivedRounds).toEqual([]);
    expect(readdirSync(f.file + '.archive')).toHaveLength(67);
  });
  it('applies byte and round budgets together without losing newest state', () => {
    const f = fixture();
    const limit = Buffer.byteLength(f.prefix + f.blocks.slice(-2).join(''));
    const result = f.run('--apply', '--max-bytes', String(limit));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).keptRounds).toEqual([7, 8]);
    expect(Buffer.byteLength(readFileSync(f.file))).toBeLessThanOrEqual(limit);
  });
  it('refuses oversized permanent state/newest round without archiving', () => {
    const f = fixture();
    expect(f.run('--apply', '--max-bytes', '1').status).toBe(1);
    expect(readFileSync(f.file, 'utf8')).toBe(f.original);
    expect(existsSync(f.file + '.archive')).toBe(false);
  });
  it('recovers already archived rounds from an interrupted prior apply', () => {
    const f = fixture();
    mkdirSync(f.file + '.archive');
    const hash = createHash('sha256').update(f.blocks[0]).digest('hex');
    writeFileSync(join(f.file + '.archive', `round-00000001-${hash}.md`), f.blocks[0]);
    expect(f.run('--apply').status).toBe(0);
    expect(readdirSync(f.file + '.archive')).toHaveLength(3);
  });
  it('refuses another compactor lock without changing active state', () => {
    const f = fixture();
    writeFileSync(f.file + '.compact.lock', 'another process');
    expect(f.run('--apply').status).toBe(1);
    expect(readFileSync(f.file, 'utf8')).toBe(f.original);
    expect(readFileSync(f.file + '.compact.lock', 'utf8')).toBe('another process');
  });
  it('never overwrites a corrupted archive or removes active rounds', () => {
    const f = fixture();
    mkdirSync(f.file + '.archive');
    const hash = createHash('sha256').update(f.blocks[0]).digest('hex');
    const archive = join(f.file + '.archive', `round-00000001-${hash}.md`);
    writeFileSync(archive, 'corrupted');
    expect(f.run('--apply').status).toBe(1);
    expect(readFileSync(archive, 'utf8')).toBe('corrupted');
    expect(readFileSync(f.file, 'utf8')).toBe(f.original);
  });
  it('rejects ambiguous headings and duplicate rounds', () => {
    const f = fixture();
    writeFileSync(f.file, f.original + '## Permanent constraints\nDo not archive.\n');
    expect(f.run('--apply').stderr).toContain('Permanent headings');
    writeFileSync(f.file, f.original + f.blocks[0]);
    expect(f.run('--apply').stderr).toContain('unique and increasing');
  });
  it('ignores example markers inside fenced code and supports Chinese markers', () => {
    const f = fixture();
    writeFileSync(f.file, '# State\n```markdown\n## Round 99\n```\n## 第 1 轮\n完成\n## 第 2 轮\n继续\n');
    const result = f.run('--apply', '--keep-rounds', '1');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).archivedRounds).toEqual([1]);
    expect(readFileSync(f.file, 'utf8')).toContain('## Round 99');
  });
  it('refuses a symlink ledger and invalid retention arguments', () => {
    const f = fixture();
    expect(f.run('--keep-rounds', '0').status).toBe(1);
    expect(f.run('--apply', '--dry-run').status).toBe(1);
    const link = join(f.dir, 'link.md');
    symlinkSync(f.file, link);
    const result = spawnSync(process.execPath, [script, '--file', link, '--apply'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(readFileSync(f.file, 'utf8')).toBe(f.original);
  });
});
