import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WeChatRegistry } from '../../packages/service/src/channels/wechat/registry.js';
import { WeChatStateStore } from '../../packages/service/src/channels/wechat/state-store.js';

const exec = promisify(execFile);
function cli(dir: string, args: string[], fixture?: { bot?: string; fail?: boolean }) {
  return exec(process.execPath, ['bin/disclaude.js', 'wechat', ...args, '--state-dir', dir], {
    env: { ...process.env, LOG_LEVEL: 'silent', LOG_TO_FILE: 'false', WECHAT_FIXTURE_BOT: fixture?.bot,
      NODE_OPTIONS: fixture ? `--import ${JSON.stringify(resolve('tests/fixtures/wechat-login-gateway.mjs'))}` : '',
      WECHAT_FIXTURE_FAILURE: fixture?.fail ? '1' : undefined }, timeout: 10000,
  });
}
function lastJson(stdout: string) { return JSON.parse(stdout.trim().split('\n').at(-1)!); }

describe('dynamic registration CLI', () => {
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
      await expect(cli(dir, ['login', '--id', first.id, '--force', '--qr-file', join(dir, 'wrong.png')], { bot: 'different' })).rejects.toThrow();
      const [record] = await registry.list();
      expect(record.enabled).toBe(true);
      expect((await new WeChatStateStore(registry.stateDir(record)).loadCredentials())?.botId).toBe('original');
      await expect(cli(dir, ['status', '--id', 'unknown'])).rejects.toThrow('Unknown WeChat registration');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
