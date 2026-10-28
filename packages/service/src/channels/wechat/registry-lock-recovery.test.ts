import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectRegistryLock, recoverRegistryLock } from './registry-lock-recovery.js';
import { WeChatStateStore } from './state-store.js';
import { WeChatRegistry } from './registry.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));

const roots: string[] = [];
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); } });
async function fixture(body = '') {
  const root = await fs.mkdtemp(join(os.tmpdir(), 'wechat-lock-recovery-')); roots.push(root);
  const directory = join(root, '.registry-lock'); await fs.mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'listener.lock'); await fs.writeFile(file, body, { mode: 0o600 });
  return { root, file, directory };
}
function simulatedLaterBoot() {
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 10_000); vi.spyOn(os, 'uptime').mockReturnValue(0);
}

it.each(['', '{partial', '{"pid":"invalid","nonce":"private-fixture"}'])(
  'quarantines observed pre-boot corruption and preserves a subsequent valid owner (%s)', async body => {
    const f = await fixture(body); const original = await fs.readFile(f.file); simulatedLaterBoot();
    const before = await fs.readdir(f.root), snapshot = await inspectRegistryLock(f.root);
    expect(snapshot.state).toBe('corrupt-before-boot'); expect(await fs.readdir(f.root)).toEqual(before);
    expect(JSON.stringify(snapshot)).not.toContain('private-fixture');
    const result = await recoverRegistryLock(f.root, snapshot);
    expect(result.alreadyRecovered).toBe(false); expect(await fs.readFile(result.archivePath)).toEqual(original);
    expect((await fs.stat(result.archivePath)).ino.toString()).toBe(snapshot.fingerprint!.inode);
    expect((await fs.stat(join(f.root, '.registry-lock-quarantine'))).mode & 0o777).toBe(0o700);
    const release = await new WeChatStateStore(f.directory).lock();
    try {
      const nextOwner = await fs.readFile(f.file);
      expect(await recoverRegistryLock(f.root, snapshot)).toMatchObject({ archivePath: result.archivePath, alreadyRecovered: true });
      expect(await fs.readFile(f.file)).toEqual(nextOwner);
    } finally { await release(); }
  });

it('keeps current-boot corruption and readable PID owners, including stale PID records', async () => {
  const fresh = await fixture(); const preview = await inspectRegistryLock(fresh.root);
  expect(preview.state).toBe('corrupt-current-boot');
  await expect(recoverRegistryLock(fresh.root, preview)).rejects.toThrow('pre-boot');
  expect(await fs.readFile(fresh.file, 'utf8')).toBe('');
  simulatedLaterBoot();
  for (const pid of [process.pid, 999_999_999]) {
    const f = await fixture(JSON.stringify({ pid, nonce: 'do-not-touch' }));
    const snapshot = await inspectRegistryLock(f.root), original = await fs.readFile(f.file);
    expect(snapshot).toMatchObject({ state: 'owner-record', ownerPid: pid });
    await expect(recoverRegistryLock(f.root, { ...snapshot, state: 'corrupt-before-boot' })).rejects.toThrow('changed');
    expect(await fs.readFile(f.file)).toEqual(original);
  }
});

it('rejects changed content, timestamps, identity or root without moving the new record', async () => {
  const f = await fixture(), other = await fixture(); simulatedLaterBoot();
  const snapshot = await inspectRegistryLock(f.root);
  await expect(recoverRegistryLock(other.root, snapshot)).rejects.toThrow('snapshot');
  await fs.utimes(f.file, new Date(), new Date(Date.now() - 9000));
  await expect(recoverRegistryLock(f.root, snapshot)).rejects.toThrow('changed');
  expect(await fs.readFile(f.file, 'utf8')).toBe('');
  await fs.writeFile(f.file, '{changed');
  await expect(recoverRegistryLock(f.root, snapshot)).rejects.toThrow('changed');
  expect(await fs.readFile(f.file, 'utf8')).toBe('{changed');
  await fs.rm(f.file); const release = await new WeChatStateStore(f.directory).lock();
  try {
    const owner = await fs.readFile(f.file);
    await expect(recoverRegistryLock(f.root, snapshot)).rejects.toThrow('changed');
    expect(await fs.readFile(f.file)).toEqual(owner);
  } finally { await release(); }
});

it('refuses redirected source/archive paths and preserves unknown files', async () => {
  const f = await fixture(), other = await fixture('canary'); simulatedLaterBoot();
  await fs.rm(f.file); await fs.symlink(other.file, f.file);
  await expect(inspectRegistryLock(f.root)).rejects.toThrow(); expect(await fs.readFile(other.file, 'utf8')).toBe('canary');
  await fs.rm(f.file); await fs.writeFile(f.file, '', { mode: 0o600 });
  const snapshot = await inspectRegistryLock(f.root), quarantine = join(f.root, '.registry-lock-quarantine');
  await fs.symlink(other.root, quarantine);
  await expect(recoverRegistryLock(f.root, snapshot)).rejects.toThrow('directory');
  expect(await fs.readFile(f.file, 'utf8')).toBe(''); await fs.rm(quarantine);
  await fs.writeFile(quarantine, 'unrelated');
  await expect(recoverRegistryLock(f.root, snapshot)).rejects.toThrow('directory');
  expect(await fs.readFile(quarantine, 'utf8')).toBe('unrelated'); expect(await fs.readFile(f.file, 'utf8')).toBe('');
});

it('serializes concurrent recovery and leaves exactly one preserved archive', async () => {
  const f = await fixture(); simulatedLaterBoot(); const snapshot = await inspectRegistryLock(f.root);
  const outcomes = await Promise.allSettled([recoverRegistryLock(f.root, snapshot), recoverRegistryLock(f.root, snapshot)]);
  const completed = outcomes.filter((value): value is PromiseFulfilledResult<Awaited<ReturnType<typeof recoverRegistryLock>>> => value.status === 'fulfilled');
  expect(completed.length).toBeGreaterThan(0);
  expect(await fs.readdir(join(f.root, '.registry-lock-quarantine'))).toHaveLength(1);
  expect(hash(await fs.readFile(completed[0].value.archivePath))).toBe(snapshot.fingerprint!.sha256);
  expect((await inspectRegistryLock(f.root)).state).toBe('missing');
});

it('reconciles an acknowledgement lost after the quarantine rename without repeating it', async () => {
  const f = await fixture(); simulatedLaterBoot(); const snapshot = await inspectRegistryLock(f.root);
  const { rename } = fs;
  const moving = vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, destination) => {
    await rename(source, destination); throw new Error('injected lost acknowledgement after committed rename');
  });
  await expect(recoverRegistryLock(f.root, snapshot)).rejects.toThrow('lost acknowledgement');
  expect((await inspectRegistryLock(f.root)).state).toBe('missing'); moving.mockRestore();
  const receipt = await recoverRegistryLock(f.root, snapshot);
  expect(receipt.alreadyRecovered).toBe(true);
  expect(hash(await fs.readFile(receipt.archivePath))).toBe(snapshot.fingerprint!.sha256);
  expect(await fs.readdir(join(f.root, '.registry-lock-quarantine'))).toHaveLength(1);
});

it('restores actual registry access while preserving registration, auth, cursor and deduplication bytes', async () => {
  const root = await fs.mkdtemp(join(os.tmpdir(), 'wechat-registry-recover-')); roots.push(root);
  const registry = new WeChatRegistry(root);
  const account = await registry.register({ botId: 'offline-fixture', token: 'private-canary', baseUrl: 'https://ilinkai.weixin.qq.com', savedAt: new Date().toISOString() });
  const store = new WeChatStateStore(registry.stateDir(account));
  await store.saveSession({ botId: account.botId, cursor: 'saved-cursor', seenMessageIds: ['already-processed'], contexts: { peer: 'private-context' } });
  const files = [join(root, 'accounts.json'), join(store.dir, 'auth.json'), join(store.dir, 'session.json')];
  const before = await Promise.all(files.map(async file => hash(await fs.readFile(file))));
  await fs.writeFile(join(root, '.registry-lock', 'listener.lock'), '', { mode: 0o600 });
  await expect(registry.list()).rejects.toThrow('Invalid WeChat listener lock'); simulatedLaterBoot();
  await recoverRegistryLock(root, await inspectRegistryLock(root));
  expect(await registry.list()).toEqual([account]);
  expect(await Promise.all(files.map(async file => hash(await fs.readFile(file))))).toEqual(before);
});
