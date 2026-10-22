import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatStateStore, validateWechatBaseUrl } from './state-store.js';

// The ESM namespace is frozen, so a plain-object copy of the same real
// functions lets one call be interleaved deterministically while every other
// fs operation stays the real implementation.
vi.mock('node:fs/promises', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs/promises')>()) }));

describe('WeChat account storage', () => {
  it('persists private credentials, replay state and reply context; excludes competing processes', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'wechat-state-'));
    const store = new WeChatStateStore(dir);
    try {
      const release = await store.lock();
      try {
        await expect(new WeChatStateStore(dir).lock()).rejects.toThrow('already in use');
        await store.saveCredentials({ botId: 'bot', token: 'private', baseUrl: 'https://ilinkai.weixin.qq.com', savedAt: new Date().toISOString() });
        await store.saveSession({ botId: 'bot', cursor: 'cursor', seenMessageIds: ['accepted'], contexts: { peer: 'context' } });
        const restarted = new WeChatStateStore(dir);
        expect((await restarted.loadCredentials())?.token).toBe('private');
        expect(await restarted.loadSession('bot')).toMatchObject({ cursor: 'cursor', seenMessageIds: ['accepted'], contexts: { peer: 'context' } });
        expect((await fs.stat(join(dir, 'auth.json'))).mode & 0o777).toBe(0o600);
        expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
        expect((await restarted.loadSession('another-bot')).cursor).toBe('');
      } finally { await release(); }
      const releaseAgain = await store.lock();
      await releaseAgain();
      await fs.writeFile(join(dir, 'session.json'), 'broken-secret-json');
      await expect(store.loadSession('bot')).rejects.toThrow('Cannot read WeChat session.json');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('retries when the previous owner releases its lock mid-acquisition; a corrupt record stays invalid', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'wechat-state-'));
    try {
      const holder = new WeChatStateStore(dir);
      const release = await holder.lock();
      const contender = new WeChatStateStore(dir);
      // Simulate the owner releasing between the contender's EEXIST and its
      // owner read: the real exclusive write fails, the holder unlocks, and the
      // subsequent read finds the lock gone.
      const realWriteFile = fs.writeFile.bind(fs);
      vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args: Parameters<typeof fs.writeFile>) => {
        try { await realWriteFile(...args); } finally { await release(); }
      });
      const acquired = await contender.lock();
      await acquired();
      await fs.writeFile(join(dir, 'listener.lock'), 'not-json');
      await expect(new WeChatStateStore(dir).lock()).rejects.toThrow('Invalid WeChat listener lock');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('rejects credential redirects outside Tencent and URLs with credentials or queries', () => {
    for (const url of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.test', 'https://u:p@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/?token=secret']) {
      expect(() => validateWechatBaseUrl(url)).toThrow();
    }
    expect(validateWechatBaseUrl('https://ilinkai.weixin.qq.com/')).toBe('https://ilinkai.weixin.qq.com');
  });
});
