import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WeChatListenerState } from './message-listener.js';
import { validMediaInbox } from './media-inbox-state.js';
import { emptyWelcomeState, validWelcomeState, type WeChatWelcomeState } from './welcome.js';

export const DEFAULT_WECHAT_STATE_DIR = join(homedir(), '.disclaude', 'wechat');
export const DEFAULT_WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';

export interface WeChatCredentials {
  token: string;
  botId: string;
  userId?: string;
  baseUrl: string;
  savedAt: string;
}

export interface WeChatSessionState extends WeChatListenerState {
  botId: string;
  contexts: Record<string, string>;
}

/** Only HTTPS Tencent iLink hosts may receive server-issued credentials. */
export function validateWechatBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid WeChat API URL'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('WeChat API URL must be an HTTPS weixin.qq.com origin');
  }
  return url.origin;
}

/** Owner-only, atomic storage. This directory must belong to one account. */
export class WeChatStateStore {
  constructor(readonly dir = DEFAULT_WECHAT_STATE_DIR) {}

  private async read<T>(name: string): Promise<T | undefined> {
    try {
      const file = join(this.dir, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) { throw new Error('invalid file'); }
      await fs.chmod(file, 0o600);
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw new Error(`Cannot read WeChat ${name}; repair or restore the state file`);
    }
  }

  private async prepare(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.dir)).isDirectory()) { throw new Error('WeChat state directory must be a real directory'); }
    await fs.chmod(this.dir, 0o700);
  }

  private async write(name: string, value: unknown): Promise<void> {
    const content = JSON.stringify(value);
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) { throw new Error(`WeChat ${name} exceeds private storage limit`); }
    await this.prepare();
    const temp = join(this.dir, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, join(this.dir, name));
    } finally { await fs.rm(temp, { force: true }); }
  }

  async loadCredentials(): Promise<WeChatCredentials | undefined> {
    const value = await this.read<WeChatCredentials>('auth.json');
    if (!value) { return undefined; }
    if (typeof value.token !== 'string' || !value.token.trim() || typeof value.botId !== 'string' || !value.botId) {
      throw new Error('Invalid WeChat credentials; run disclaude wechat login');
    }
    value.baseUrl = validateWechatBaseUrl(value.baseUrl);
    return value;
  }

  async saveCredentials(value: WeChatCredentials): Promise<void> {
    validateWechatBaseUrl(value.baseUrl);
    await this.write('auth.json', value);
    // A fresh login invalidates the previous account's cursor and context tokens.
    await this.saveSession({ botId: value.botId, cursor: '', seenMessageIds: [], contexts: {} });
  }

  async loadSession(botId: string): Promise<WeChatSessionState> {
    const value = await this.read<WeChatSessionState>('session.json');
    if (!value || value.botId !== botId) { return { botId, cursor: '', seenMessageIds: [], contexts: {} }; }
    if (typeof value.cursor !== 'string' || !Array.isArray(value.seenMessageIds) || !value.seenMessageIds.every(x => typeof x === 'string') || !value.contexts || typeof value.contexts !== 'object' || Array.isArray(value.contexts) || Object.values(value.contexts).some(x => typeof x !== 'string')) {
      throw new Error('Invalid WeChat session state; restore the file before restarting');
    }
    if (value.mediaInbox !== undefined && !validMediaInbox(value.mediaInbox)) { throw new Error('Invalid WeChat media recovery state; restore the session file'); }
    return value;
  }

  async saveSession(state: WeChatSessionState): Promise<void> { await this.write('session.json', state); }

  async loadWelcome(botId: string): Promise<WeChatWelcomeState> {
    const state = await this.read<WeChatWelcomeState>('welcome.json');
    if (!state) { return emptyWelcomeState(botId); }
    if (!validWelcomeState(state)) { throw new Error('Invalid WeChat welcome state; repair it privately'); }
    return state.botId === botId ? state : emptyWelcomeState(botId);
  }
  async saveWelcome(state: WeChatWelcomeState): Promise<void> {
    if (!validWelcomeState(state)) { throw new Error('Invalid WeChat welcome state'); }
    await this.write('welcome.json', state);
  }

  /** Publish a complete owner record, never an empty canonical lock on write failure. */
  private async publishLock(file: string, nonce: string): Promise<void> {
    const pending = join(this.dir, `.listener-${nonce}.tmp`);
    const handle = await fs.open(pending, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      await handle.sync();
      await handle.close();
      // link is exclusive like wx, but makes the already-written inode visible
      // in one operation. Both paths are in the same account directory.
      await fs.link(pending, file);
    } finally {
      await handle.close().catch(() => {});
      // Only our unique staging file is removed. A published canonical lock
      // stays owned even if best-effort staging cleanup fails.
      await fs.rm(pending, { force: true }).catch(() => {});
    }
  }

  /** Excludes concurrent listeners/login writers, recovering locks from dead PIDs. */
  async lock(): Promise<() => Promise<void>> {
    await this.prepare();
    const file = join(this.dir, 'listener.lock');
    const nonce = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.publishLock(file, nonce);
        return async () => {
          const owner = await this.read<{ nonce: string }>('listener.lock');
          if (owner?.nonce === nonce) { await fs.rm(file, { force: true }); }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
        // The previous owner can release (unlink) its lock between our EEXIST
        // and this read; a vanished record means retry, not corruption.
        let record: string;
        try { record = await fs.readFile(file, 'utf8'); }
        catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
          throw new Error('Invalid WeChat listener lock');
        }
        let owner: { pid?: unknown };
        try { owner = JSON.parse(record); } catch { throw new Error('Invalid WeChat listener lock'); }
        if (!owner || !Number.isInteger(owner.pid) || (owner.pid as number) <= 0) { throw new Error('Invalid WeChat listener lock'); }
        try { process.kill(owner.pid as number, 0); }
        catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') { await fs.rm(file, { force: true }); continue; }
        }
        throw new Error('WeChat account is already in use; stop its listener before login or restart');
      }
    }
    throw new Error('Cannot acquire WeChat account lock');
  }
}
