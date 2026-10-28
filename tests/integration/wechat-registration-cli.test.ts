import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WeChatRegistry } from '../../packages/service/src/channels/wechat/registry.js';
import { WeChatStateStore } from '../../packages/service/src/channels/wechat/state-store.js';

const exec = promisify(execFile);
function cli(dir: string, args: string[], fixture?: { bot?: string; user?: string; fail?: boolean; expired?: boolean; preboot?: boolean }) {
  return exec(process.execPath, ['bin/disclaude.js', 'wechat', ...args, '--state-dir', dir], {
    env: { ...process.env, LOG_LEVEL: 'silent', LOG_TO_FILE: 'false', WECHAT_FIXTURE_BOT: fixture?.bot,
      WECHAT_FIXTURE_USER: fixture?.user,
      NODE_OPTIONS: fixture ? `--import ${JSON.stringify(resolve(fixture.preboot ? 'tests/fixtures/wechat-preboot-lock.mjs' : 'tests/fixtures/wechat-login-gateway.mjs'))}` : '',
      WECHAT_FIXTURE_FAILURE: fixture?.fail ? '1' : undefined,
      WECHAT_FIXTURE_SESSION_EXPIRED: fixture?.expired ? '1' : undefined }, timeout: 10000,
  });
}
function lastJson(stdout: string) { return JSON.parse(stdout.trim().split('\n').at(-1)!); }

describe('dynamic registration CLI', () => {
  it('inspects without registry access and recovers an exact simulated pre-boot snapshot once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-lock-cli-'));
    try {
      const lockDir = join(dir, '.registry-lock'), file = join(lockDir, 'listener.lock'), snapshotFile = join(dir, 'snapshot.json');
      await mkdir(lockDir, { mode: 0o700 }); await writeFile(file, '', { mode: 0o600 });
      const current = await cli(dir, ['lock-inspect']);
      expect(JSON.parse(current.stdout)).toMatchObject({ ok: true, state: 'corrupt-current-boot' });
      await writeFile(snapshotFile, current.stdout, { mode: 0o600 });
      await expect(cli(dir, ['lock-recover', '--snapshot', snapshotFile])).rejects.toThrow('pre-boot');
      expect(await readFile(file, 'utf8')).toBe('');
      const preview = await cli(dir, ['lock-inspect'], { preboot: true });
      expect(JSON.parse(preview.stdout).state).toBe('corrupt-before-boot'); await writeFile(snapshotFile, preview.stdout);
      const recovered = JSON.parse((await cli(dir, ['lock-recover', '--snapshot', snapshotFile], { preboot: true })).stdout);
      expect(recovered).toMatchObject({ ok: true, alreadyRecovered: false }); expect(await readFile(recovered.archivePath, 'utf8')).toBe('');
      const release = await new WeChatStateStore(lockDir).lock();
      try {
        const owner = await readFile(file);
        expect(JSON.parse((await cli(dir, ['lock-recover', '--snapshot', snapshotFile], { preboot: true })).stdout)).toMatchObject({ ok: true, alreadyRecovered: true });
        expect(await readFile(file)).toEqual(owner);
      } finally { await release(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('scans two new accounts without names, lists public IDs, and applies account management', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-registration-cli-'));
    try {
      expect(JSON.parse((await cli(dir, ['status'])).stdout)).toMatchObject({ configured: false, authenticated: 'not-checked', accounts: [] });
      const firstOutput = await cli(dir, ['login', '--qr-file', join(dir, 'first.png')], { bot: 'first-bot' });
      const first = lastJson(firstOutput.stdout);
      const second = lastJson((await cli(dir, ['login', '--qr-file', join(dir, 'second.png')], { bot: 'second-bot' })).stdout);
      expect(first.registered && second.registered).toBe(true);
      expect(first.id).not.toBe(second.id);
      expect(first.channelId).toBe(`wechat:${first.id}`);
      expect((await stat(join(dir, 'first.png'))).mode & 0o777).toBe(0o600);
      const status = await cli(dir, ['status']);
      expect(JSON.parse(status.stdout).accounts).toHaveLength(2);
      expect(status.stdout + status.stderr + firstOutput.stdout + firstOutput.stderr).not.toContain('fixture-private-token');
      await cli(dir, ['disable', first.id]);
      expect(JSON.parse((await cli(dir, ['status', '--id', first.id])).stdout).accounts[0].enabled).toBe(false);
      const renewed = lastJson((await cli(dir, ['login', '--id', first.id, '--force', '--qr-file', join(dir, 'renew.png')], { bot: 'first-bot' })).stdout);
      expect(renewed.id).toBe(first.id);
      await cli(dir, ['remove', second.id]);
      expect((await new WeChatRegistry(dir).list()).map(account => account.id)).toEqual([first.id]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not register failed QR flows or overwrite an identity on mismatched reauthentication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-registration-cli-failure-'));
    try {
      await expect(cli(dir, ['login', '--qr-file', join(dir, 'failed.png')], { fail: true })).rejects.toThrow();
      const registry = new WeChatRegistry(dir);
      expect(await registry.list()).toEqual([]);
      const first = lastJson((await cli(dir, ['login', '--qr-file', join(dir, 'first.png')], { bot: 'original' })).stdout);
      // Same user scanning a new bot identity (#5480): refuse the overwrite,
      // explain the change, and point at a plain login as the continuation.
      const mismatch = await cli(dir, ['login', '--id', first.id, '--force', '--qr-file', join(dir, 'wrong.png')], { bot: 'different' }).catch(error => error);
      expect(mismatch.code).toBe(1);
      const entries = mismatch.stdout.trim().split('\n')
        .filter(line => line.startsWith('{') && line.endsWith('}')).map(line => JSON.parse(line));
      expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, stage: 'identity-changed',
        saved: false, targetId: first.id, registeredBotId: 'original', scannedBotId: 'different', sameUser: true,
        next: `disclaude wechat login --state-dir ${dir}` })]));
      const [record] = await registry.list();
      expect(record.enabled).toBe(true);
      expect((await new WeChatStateStore(registry.stateDir(record)).loadCredentials())?.botId).toBe('original');
      // A scan from a different WeChat user reports the unexpected identity
      // instead of offering the same-user continuation.
      const stranger = await cli(dir, ['login', '--id', first.id, '--force', '--qr-file', join(dir, 'stranger.png')],
        { bot: 'different', user: 'someone-else@im.wechat' }).catch(error => error);
      expect(stranger.code).toBe(1);
      expect(stranger.stdout).toContain('"sameUser":false');
      await expect(cli(dir, ['status', '--id', 'unknown'])).rejects.toThrow('Unknown WeChat registration');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reports an expired login, not a recovery, when the rollback probe is rejected (#5479)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-registration-cli-rollback-'));
    try {
      const first = lastJson((await cli(dir, ['login', '--qr-file', join(dir, 'first.png')], { bot: 'original' })).stdout);
      // The forced re-login fails and the saved credentials are expired
      // server-side: the rollback must restore the account, probe it, and say
      // the login needs a scan instead of implying the account recovered.
      const failure = await cli(dir, ['login', '--id', first.id, '--force', '--qr-file', join(dir, 'renew.png')],
        { bot: 'original', fail: true, expired: true }).catch(error => error);
      const report = lastJson(failure.stdout);
      expect(report).toMatchObject({ restored: first.id, verified: false, loginExpired: true });
      expect(report.next).toBe(`disclaude wechat login --id ${first.id} --force`);
      const [record] = await new WeChatRegistry(dir).list();
      expect(record.enabled).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('verifies a still-valid login after a rolled-back re-login (#5479)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-registration-cli-rollback-ok-'));
    try {
      const first = lastJson((await cli(dir, ['login', '--qr-file', join(dir, 'first.png')], { bot: 'original' })).stdout);
      const failure = await cli(dir, ['login', '--id', first.id, '--force', '--qr-file', join(dir, 'renew.png')],
        { bot: 'original', fail: true }).catch(error => error);
      const report = lastJson(failure.stdout);
      expect(report).toMatchObject({ restored: first.id, verified: true });
      expect(report).not.toHaveProperty('loginExpired');
      expect(report.note).toBe('account check passed does not prove message delivery');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reports login stages and verifies fresh credentials before declaring registration (#5479)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-registration-cli-stages-'));
    try {
      const output = await cli(dir, ['login', '--qr-file', join(dir, 'fresh.png')], { bot: 'stage-bot' });
      const stages = output.stdout.trim().split('\n')
        .filter(line => line.startsWith('{') && line.endsWith('}'))
        .map(line => JSON.parse(line))
        .filter(entry => entry.stage)
        .map(entry => entry.stage);
      expect(stages).toEqual(['waiting-for-scan', 'confirmed', 'submitting-credentials', 'verifying-connection']);
      const report = lastJson(output.stdout);
      expect(report).toMatchObject({ ok: true, registered: true, verified: true });
      expect(report.note).toBe('account check passed does not prove message delivery');
      expect(report).not.toHaveProperty('next');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reports a rejected fresh login as registered but unverified, not activated (#5479)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-registration-cli-fresh-expired-'));
    try {
      // The scan confirms offline but the server rejects the new credentials
      // immediately: committing the registration must not read as activation.
      const output = await cli(dir, ['login', '--qr-file', join(dir, 'fresh.png')], { bot: 'stage-bot', expired: true });
      const report = lastJson(output.stdout);
      expect(report).toMatchObject({ ok: true, registered: true, verified: false, loginExpired: true });
      expect(report.next).toContain('disclaude wechat login --id ');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
