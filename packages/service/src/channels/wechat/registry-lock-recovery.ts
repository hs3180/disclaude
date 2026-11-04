import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WeChatStateStore, wechatLockPid } from './state-store.js';

interface Fingerprint {
  device: string; inode: string; ctimeNs: string; mtimeNs: string; birthtimeNs: string; bytes: number; sha256: string;
}
export interface RegistryLockInspection {
  version: 1; registryRoot: string; state: 'missing' | 'owner-record' | 'corrupt-current-boot' | 'corrupt-before-boot';
  fingerprint?: Fingerprint; ownerPid?: number;
}
const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const key = (f: Fingerprint): string => JSON.stringify([f.device, f.inode, f.ctimeNs, f.mtimeNs, f.birthtimeNs, f.bytes, f.sha256]);
const uid = (): bigint => {
  if (!process.getuid) { throw new Error('Registry lock recovery requires verifiable Unix file ownership'); }
  return BigInt(process.getuid());
};
async function directory(path: string, privateMode = false): Promise<void> {
  const stat = await fs.lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== uid() || (stat.mode & (privateMode ? 0o077n : 0o022n)) !== 0n) {
    throw new Error('Registry lock recovery requires an owned real directory with safe permissions');
  }
}
async function privateDirectory(path: string): Promise<void> {
  try { await fs.mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
  await directory(path, true);
}
async function readFile(path: string): Promise<{ fingerprint: Fingerprint; pid?: number; beforeBoot: boolean }> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.uid !== uid() || stat.nlink !== 1n || stat.size > 16_384n) {
      throw new Error('Registry lock must be an owned, bounded regular file with one link');
    }
    const body = await handle.readFile();
    const after = await fs.lstat(path, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size ||
      after.ctimeNs !== stat.ctimeNs || after.mtimeNs !== stat.mtimeNs) { throw new Error('Registry lock changed during inspection'); }
    const bootCutoff = BigInt(Math.floor(Date.now() - os.uptime() * 1000 - 2000)) * 1_000_000n;
    return { fingerprint: { device: String(stat.dev), inode: String(stat.ino), ctimeNs: String(stat.ctimeNs),
      mtimeNs: String(stat.mtimeNs), birthtimeNs: String(stat.birthtimeNs), bytes: Number(stat.size), sha256: digest(body) },
    pid: wechatLockPid(body.toString('utf8')),
    beforeBoot: stat.ctimeNs < bootCutoff && stat.mtimeNs < bootCutoff && stat.birthtimeNs < bootCutoff };
  } finally { await handle.close(); }
}

/** Read-only; never create a registry, chmod a source or print lock contents. */
export async function inspectRegistryLock(root: string): Promise<RegistryLockInspection> {
  const registryRoot = resolve(root); await directory(registryRoot);
  try {
    await directory(join(registryRoot, '.registry-lock'));
    const value = await readFile(join(registryRoot, '.registry-lock', 'listener.lock'));
    return { version: 1, registryRoot, fingerprint: value.fingerprint,
      state: value.pid !== undefined ? 'owner-record' : value.beforeBoot ? 'corrupt-before-boot' : 'corrupt-current-boot',
      ...(value.pid !== undefined ? { ownerPid: value.pid } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { version: 1, registryRoot, state: 'missing' }; }
    throw error;
  }
}
async function sync(path: string): Promise<void> {
  const handle = await fs.open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export interface RegistryLockAutoRecovery {
  registryRoot: string;
  outcome: 'absent' | 'quarantined';
  /** Observed corruption class and evidence fingerprint when a residue was moved. */
  state?: 'corrupt-current-boot' | 'corrupt-before-boot';
  quarantinePath?: string;
  bytes?: number;
  sha256?: string;
}

/** Quarantine a malformed registry guard lock so the next acquisition rebuilds it (#5513).
 *
 * publishLock() stages owner records and links them into place atomically, so a
 * canonical listener.lock without a readable PID cannot belong to a live holder
 * of this or a later release; it is residue, typically the ENOSPC-emptied file
 * left by pre-#5577 direct writes. Unlike recoverRegistryLock this path also
 * heals same-boot corruption, which an operator cannot recover without a
 * reboot. The residue is renamed (never deleted) to a timestamped `.corrupt`
 * sibling for inspection; repairs serialize on the repair guard and re-inspect
 * inside it, so a valid owner published meanwhile is never moved. Throws a
 * structured, actionable error when the lock cannot be proven safe to move.
 */
export async function autoRecoverRegistryLock(root: string): Promise<RegistryLockAutoRecovery> {
  const registryRoot = resolve(root), lockFile = join(registryRoot, '.registry-lock', 'listener.lock');
  const observed = async (): Promise<RegistryLockAutoRecovery> => {
    let snapshot: RegistryLockInspection;
    try { snapshot = await inspectRegistryLock(registryRoot); }
    catch (error) {
      throw new Error(`WeChat registry lock ${lockFile} cannot be inspected or proven safe to rebuild automatically; run 'disclaude wechat lock-inspect' and repair its state: ${(error as Error).message}`);
    }
    if (snapshot.state === 'missing' || snapshot.state === 'owner-record') { return { registryRoot, outcome: 'absent' }; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantinePath = join(registryRoot, '.registry-lock', `listener.lock.${stamp}.${randomUUID().slice(0, 8)}.corrupt`);
    await fs.rename(lockFile, quarantinePath);
    return { registryRoot, outcome: 'quarantined', state: snapshot.state, quarantinePath,
      bytes: snapshot.fingerprint?.bytes, sha256: snapshot.fingerprint?.sha256 };
  };
  const guardDir = join(registryRoot, '.registry-lock-repair');
  await privateDirectory(guardDir);
  const release = await new WeChatStateStore(guardDir).lock();
  try { return await observed(); } finally { await release(); }
}

/** Only explicitly observed, untouched pre-boot corruption is recoverable.
 * Normal lock contenders never remove malformed records; cooperating repairs
 * serialize separately. Valid/new records are never removed by this operation.
 */
export async function recoverRegistryLock(root: string, input: unknown): Promise<{ archivePath: string; alreadyRecovered: boolean }> {
  const registryRoot = resolve(root), expected = input as RegistryLockInspection;
  const f = expected?.fingerprint;
  if (expected?.version !== 1 || expected.registryRoot !== registryRoot || expected.state !== 'corrupt-before-boot' || !f ||
    !['device', 'inode', 'ctimeNs', 'mtimeNs', 'birthtimeNs'].every(name => typeof f[name as keyof Fingerprint] === 'string' && /^\d+$/.test(f[name as keyof Fingerprint] as string)) ||
    !Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > 16_384 || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) {
    throw new Error('Expected the unchanged JSON snapshot from wechat lock-inspect; only pre-boot corruption is recoverable');
  }
  await directory(registryRoot);
  const archiveRoot = join(registryRoot, '.registry-lock-quarantine'), archiveDir = join(archiveRoot, digest(key(f)));
  const archivePath = join(archiveDir, 'listener.lock');
  const archived = async (): Promise<boolean> => {
    try {
      await directory(archiveRoot, true); await directory(archiveDir, true);
      const saved = await readFile(archivePath);
      if (saved.fingerprint.device !== f.device || saved.fingerprint.inode !== f.inode ||
        saved.fingerprint.sha256 !== f.sha256 || saved.fingerprint.bytes !== f.bytes) { throw new Error('Recovery archive does not match the observed lock'); }
      await sync(archiveDir); await sync(archiveRoot); await sync(registryRoot); await sync(join(registryRoot, '.registry-lock'));
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; } throw error; }
  };
  if (await archived()) { return { archivePath, alreadyRecovered: true }; }
  const validate = async (): Promise<void> => {
    const current = await inspectRegistryLock(registryRoot);
    if (current.state !== 'corrupt-before-boot' || !current.fingerprint || key(current.fingerprint) !== key(f)) {
      throw new Error('Registry lock changed or cannot be proved older than this boot; preserve it and inspect its owner');
    }
  };
  await validate();
  const guardDir = join(registryRoot, '.registry-lock-repair'); await privateDirectory(guardDir);
  const release = await new WeChatStateStore(guardDir).lock();
  try {
    if (await archived()) { return { archivePath, alreadyRecovered: true }; }
    await privateDirectory(archiveRoot); await privateDirectory(archiveDir);
    await sync(archiveRoot); await sync(registryRoot);
    await validate();
    await fs.rename(join(registryRoot, '.registry-lock', 'listener.lock'), archivePath);
    await sync(archiveDir); await sync(join(registryRoot, '.registry-lock'));
    if (!await archived()) { throw new Error('Recovery archive must be reconciled before retry'); }
    return { archivePath, alreadyRecovered: false };
  } finally { await release(); }
}
