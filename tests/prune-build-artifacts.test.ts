import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Build tooling is native JavaScript, outside package TS projects.
import { prunePackageArtifacts } from '../scripts/prune-build-artifacts.mjs';

const fixtures: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'disclaude-prune-test-'));
  fixtures.push(dir);
  mkdirSync(join(dir, 'src/task'), { recursive: true });
  mkdirSync(join(dir, 'dist/task'), { recursive: true });
  return dir;
}
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('obsolete TypeScript build artifacts', () => {
  it('removes deleted modules and tests while retaining live outputs and assets', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'src/task/live.ts'), 'export {};');
    for (const name of [
      'task-tracker',
      'task-tracker.test',
      'dialogue-message-tracker',
      'dialogue-message-tracker.test',
      'live',
    ]) {
      for (const ext of ['.js', '.js.map', '.d.ts', '.d.ts.map'])
        writeFileSync(join(dir, 'dist/task', name + ext), 'generated');
    }
    writeFileSync(join(dir, 'dist/task/asset.json'), '{}');
    expect(prunePackageArtifacts(dir)).toHaveLength(16);
    expect(existsSync(join(dir, 'dist/task/live.js'))).toBe(true);
    expect(existsSync(join(dir, 'dist/task/live.d.ts.map'))).toBe(true);
    expect(existsSync(join(dir, 'dist/task/asset.json'))).toBe(true);
    expect(prunePackageArtifacts(dir)).toEqual([]);
  });

  it('does not follow symbolic links', () => {
    const dir = fixture();
    const outside = fixture();
    writeFileSync(join(outside, 'untouched.js'), 'keep');
    symlinkSync(outside, join(dir, 'dist/external'));
    symlinkSync(join(outside, 'untouched.js'), join(dir, 'dist/linked.js'));
    expect(prunePackageArtifacts(dir)).toEqual([]);
    expect(existsSync(join(outside, 'untouched.js'))).toBe(true);
    expect(existsSync(join(dir, 'dist/linked.js'))).toBe(true);
  });

  it('refuses cleanup when the source tree is missing', () => {
    const dir = fixture();
    rmSync(join(dir, 'src'), { recursive: true });
    expect(() => prunePackageArtifacts(dir)).toThrow('Missing source directory');
  });

  it('refuses a symlinked output root', () => {
    const dir = fixture();
    const outside = fixture();
    rmSync(join(dir, 'dist'), { recursive: true });
    symlinkSync(join(outside, 'dist'), join(dir, 'dist'));
    expect(() => prunePackageArtifacts(dir)).toThrow('symlinked source/output tree');
  });

  it('accepts a fresh checkout without dist', () => {
    const dir = fixture();
    rmSync(join(dir, 'dist'), { recursive: true });
    expect(prunePackageArtifacts(dir)).toEqual([]);
  });
});
