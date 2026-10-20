import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatStateStore, validateWechatBaseUrl } from './state-store.js';

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

  it('rejects credential redirects outside Tencent and URLs with credentials or queries', () => {
    for (const url of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.test', 'https://u:p@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/?token=secret']) {
      expect(() => validateWechatBaseUrl(url)).toThrow();
    }
    expect(validateWechatBaseUrl('https://ilinkai.weixin.qq.com/')).toBe('https://ilinkai.weixin.qq.com');
  });
});
