import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, symlink, writeFile, readlink, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { assertChromiumProfileAvailable, assertChromiumProfileVersion } from '../scripts/chromium-profile.mjs';

async function profile(check: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dc-profile-guard-'));
  try { await check(root); } finally { await rm(root, { recursive: true, force: true }); }
}
describe('profile compatibility before service activation', () => {
  it('allows a new profile and compatible recorded versions', () => profile(async path => {
    expect(() => assertChromiumProfileAvailable(path)).not.toThrow();
    expect(() => assertChromiumProfileVersion(path, 'Chrome/155.0.0.0')).not.toThrow();
    await writeFile(join(path, 'Last Version'), '155.0.1.2');
    expect(() => assertChromiumProfileVersion(path, 'Chrome/155.0.2.3')).not.toThrow();
    expect(() => assertChromiumProfileVersion(path, 'Chromium 156.0.0.0')).not.toThrow();
    expect(() => assertChromiumProfileVersion(path, 'Chrome/154.0.9.9')).toThrow('major-version downgrade');
  }));
  it('refuses a live foreign owner while allowing the known service owner', () => profile(async path => {
    await symlink(`${hostname()}-${process.pid}`, join(path, 'SingletonLock'));
    expect(() => assertChromiumProfileAvailable(path)).toThrow('in use by another process');
    expect(() => assertChromiumProfileAvailable(path, process.pid)).not.toThrow();
  }));
  it('allows the browser to reclaim a proven dead local owner without deleting its marker', () => profile(async path => {
    const lock = join(path, 'SingletonLock'); const target = `${hostname()}-12345`;
    await symlink(target, lock);
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('no process'), { code: 'ESRCH' }); });
    try {
      expect(() => assertChromiumProfileAvailable(path)).not.toThrow();
      expect(await readlink(lock)).toBe(target);
    } finally { probe.mockRestore(); }
  }));
  it('preserves unknown and remote-host ownership', () => profile(async path => {
    const lock = join(path, 'SingletonLock');
    await symlink(`foreign-host-${process.pid}`, lock);
    expect(() => assertChromiumProfileAvailable(path, process.pid)).toThrow('another host');
    await rm(lock); await writeFile(lock, 'unexpected lock');
    expect(() => assertChromiumProfileAvailable(path)).toThrow('unrecognized lock');
  }));
  it('refuses unknown or excessive version metadata', () => profile(async path => {
    const version = join(path, 'Last Version'); await writeFile(version, 'not a version');
    expect(() => assertChromiumProfileVersion(path, 'Chrome/155.0.0.0')).toThrow('Cannot compare');
    await writeFile(version, '0'.repeat(4097));
    expect(() => assertChromiumProfileVersion(path, 'Chrome/155.0.0.0')).toThrow('too large');
  }));
});
