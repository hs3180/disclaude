/** #5479: a forced re-login protects concurrent management, sibling accounts, and delivered messages. */
import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WeChatRegistry } from '../../packages/service/src/channels/wechat/registry.js';
import { WeChatStateStore } from '../../packages/service/src/channels/wechat/state-store.js';
import { WeChatMessageListener } from '../../packages/service/src/channels/wechat/message-listener.js';
import type { WeChatApiClient } from '../../packages/service/src/channels/wechat/api-client.js';
import type { WeChatUpdate } from '../../packages/service/src/channels/wechat/types.js';

const exec = promisify(execFile);
function cli(dir: string, args: string[], fixture?: { bot?: string; fail?: boolean; hold?: boolean }) {
  return exec(process.execPath, ['bin/disclaude.js', 'wechat', ...args, '--state-dir', dir], {
    env: { ...process.env, LOG_LEVEL: 'silent', LOG_TO_FILE: 'false', WECHAT_FIXTURE_BOT: fixture?.bot,
      NODE_OPTIONS: fixture ? `--import ${JSON.stringify(resolve('tests/fixtures/wechat-login-gateway.mjs'))}` : '',
      WECHAT_FIXTURE_FAILURE: fixture?.fail ? '1' : undefined,
      WECHAT_FIXTURE_HOLD_QR: fixture?.hold ? '1' : undefined }, timeout: 30000,
  });
}
function lastJson(stdout: string) { return JSON.parse(stdout.trim().split('\n').at(-1)!); }

describe('forced re-login isolation (#5479)', () => {
  it('does not let the rollback clobber a concurrent disable; sibling accounts keep their state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-relogin-disable-'));
    const registry = new WeChatRegistry(dir);
    try {
      const target = lastJson((await cli(dir, ['login', '--qr-file', join(dir, 'target.png')], { bot: 'target-bot' })).stdout);
      const sibling = lastJson((await cli(dir, ['login', '--qr-file', join(dir, 'sibling.png')], { bot: 'sibling-bot' })).stdout);
      const before = (await registry.list()).find(account => account.id === sibling.id)!;
      // The held QR keeps the re-login (and its rollback window) open so a
      // concurrent operator action can land inside it.
      const pending = cli(dir, ['login', '--id', target.id, '--force', '--qr-file', join(dir, 'renew.png'),
        '--timeout-ms', '6000'], { bot: 'target-bot', hold: true }).catch(error => error);
      await vi.waitFor(async () => expect((await registry.list()).find(account => account.id === target.id)?.enabled).toBe(false), { timeout: 10000 });
      await cli(dir, ['disable', target.id]);
      const failure = await pending;
      expect(failure.code).toBe(1);
      // The concurrent management decision (a fresh generation) survives the
      // rollback: the account is not silently re-enabled.
      const accounts = await registry.list();
      expect(accounts.find(account => account.id === target.id)?.enabled).toBe(false);
      expect(accounts.find(account => account.id === target.id)?.botId).toBe('target-bot');
      // The sibling account is untouched: same record, same credentials.
      const after = accounts.find(account => account.id === sibling.id)!;
      expect(after.enabled).toBe(true);
      expect(after.generation).toBe(before.generation);
      expect((await new WeChatStateStore(registry.stateDir(after)).loadCredentials())?.botId).toBe('sibling-bot');
      expect(String(failure.stdout)).not.toContain('"restored"');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('leaves a concurrently removed account removed instead of restoring it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-relogin-remove-'));
    const registry = new WeChatRegistry(dir);
    try {
      const target = lastJson((await cli(dir, ['login', '--qr-file', join(dir, 'target.png')], { bot: 'target-bot' })).stdout);
      const pending = cli(dir, ['login', '--id', target.id, '--force', '--qr-file', join(dir, 'renew.png'),
        '--timeout-ms', '6000'], { bot: 'target-bot', hold: true }).catch(error => error);
      await vi.waitFor(async () => expect((await registry.list()).find(account => account.id === target.id)?.enabled).toBe(false), { timeout: 10000 });
      await cli(dir, ['remove', target.id]);
      const failure = await pending;
      expect(failure.code).toBe(1);
      expect(await registry.list()).toEqual([]);
      expect(String(failure.stdout)).not.toContain('"restored"');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not replay delivered messages when a batch is re-fetched before its checkpoint lands', async () => {
    const update = (id: string): WeChatUpdate => ({ from_user_id: 'peer', message_id: id,
      item_list: [{ type: 1, text_item: { text: `message ${id}` } }] } as WeChatUpdate);
    // A batch is delivered but its checkpoint fails (process exit, slow disk):
    // without the ack the same batch is fetched again.
    let pending = [update('m1'), update('m2')];
    let cursor = 'cursor-before-batch';
    let checkpointFails = true;
    const acked: number[] = [];
    const delivered: string[] = [];
    const client = {
      // An empty long poll resolves quietly instead of spinning the loop hot.
      getUpdates: async () => { if (pending.length) { return pending.slice(); } await new Promise(resolve => setTimeout(resolve, 25)); return []; },
      acknowledgeUpdates: () => { acked.push(pending.length); if (pending.length) { cursor = 'cursor-after-batch'; pending = []; } },
      getUpdatesCursor: () => cursor,
      setUpdatesCursor: () => {},
    };
    const listener = new WeChatMessageListener(client as unknown as WeChatApiClient,
      async message => { delivered.push(message.messageId); }, {
        checkpoint: async () => { if (checkpointFails) { checkpointFails = false; throw new Error('checkpoint unavailable'); } },
      });
    try {
      listener.start();
      await vi.waitFor(() => expect(acked.at(0)).toBe(2), { timeout: 10000 });
    } finally { await listener.stop(); }
    // Both messages were delivered exactly once: the re-fetched batch hit the
    // dedup cache instead of replaying sends whose outcome is unknown.
    expect(delivered).toEqual(['m1', 'm2']);
    expect(client.getUpdatesCursor()).toBe('cursor-after-batch');
  });
});
