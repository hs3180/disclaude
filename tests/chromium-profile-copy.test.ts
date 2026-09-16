import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { planChromiumProfileCopy, copyChromiumProfile } from '../scripts/chromium-profile-copy.mjs';
async function fixture(check: (root: string, source: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dc-copy-profile-'));
  try {
    const source = join(root, 'source'); await mkdir(source);
    await writeFile(join(source, 'Local State'), '{}');
    await writeFile(join(source, 'Last Version'), '155.0.0.0');
    await check(root, source);
  } finally { await rm(root, { recursive: true, force: true }); }
}
describe('offline profile copy boundaries', () => {
  it('copies bytes into a new private directory and supports copying a prior copy', () => fixture(async (root, source) => {
    await mkdir(join(source, 'Default')); await writeFile(join(source, 'Default', 'Preferences'), '{"marker":"original"}');
    await symlink('155.0.0.0', join(source, 'RunningChromeVersion'));
    const target = join(root, 'copy'); const plan = await planChromiumProfileCopy(source, target, 'Chrome/155.0.0.0');
    await expect(access(target)).rejects.toThrow();
    const record = await copyChromiumProfile(plan);
    await expect(access(join(target, 'RunningChromeVersion'))).rejects.toThrow();
    expect(record.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(target, 'Default', 'Preferences'), 'utf8')).toBe('{"marker":"original"}');
    await writeFile(join(target, 'Default', 'Preferences'), 'changed copy');
    expect(await readFile(join(source, 'Default', 'Preferences'), 'utf8')).toBe('{"marker":"original"}');
    await copyChromiumProfile(await planChromiumProfileCopy(target, join(root, 'second'), 'Chrome/155.0.0.0'));
  }));
  it('refuses existing, nested and symlinked destinations without replacing data', () => fixture(async (root, source) => {
    await expect(planChromiumProfileCopy(source, source, 'Chrome/155.0.0.0')).rejects.toThrow('already exists');
    await expect(planChromiumProfileCopy(source, join(source, 'nested'), 'Chrome/155.0.0.0')).rejects.toThrow('contain one another');
    await symlink(source, join(root, 'alias'));
    await expect(planChromiumProfileCopy(source, join(root, 'alias', 'nested'), 'Chrome/155.0.0.0')).rejects.toThrow('contain one another');
    await symlink(join(root, 'absent'), join(root, 'dangling'));
    await expect(planChromiumProfileCopy(source, join(root, 'dangling'), 'Chrome/155.0.0.0')).rejects.toThrow('already exists');
  }));
  it('refuses a live source or links to external files', () => fixture(async (root, source) => {
    await symlink(`${hostname()}-${process.pid}`, join(source, 'SingletonLock'));
    await expect(planChromiumProfileCopy(source, join(root, 'copy'), 'Chrome/155.0.0.0')).rejects.toThrow('in use');
    await rm(join(source, 'SingletonLock')); await symlink('/etc/passwd', join(source, 'external'));
    await expect(planChromiumProfileCopy(source, join(root, 'copy'), 'Chrome/155.0.0.0')).rejects.toThrow('symlinks');
  }));
  it('rejects a changed preview and cancellation without publishing a destination', () => fixture(async (root, source) => {
    const destination = join(root, 'copy'); const plan = await planChromiumProfileCopy(source, destination, 'Chrome/155.0.0.0');
    await writeFile(join(source, 'new-file'), 'source changed');
    await expect(copyChromiumProfile(plan)).rejects.toThrow('changed after');
    const updated = await planChromiumProfileCopy(source, destination, 'Chrome/155.0.0.0');
    const controller = new AbortController(); controller.abort();
    await expect(copyChromiumProfile(updated, controller.signal)).rejects.toThrow();
    expect(await readdir(root)).toEqual(['source']);
  }));
});
