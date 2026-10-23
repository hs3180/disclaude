import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_WECHAT_STATE_DIR, WeChatStateStore, validateWechatBaseUrl, type WeChatCredentials } from './state-store.js';

export interface WeChatRegistration {
  id: string;
  botId: string;
  enabled: boolean;
  generation: string;
  createdAt: string;
  /** Only an imported singleton retains its existing unqualified conversations. */
  legacy?: boolean;
}
interface RegistryDocument { version: 1; accounts: WeChatRegistration[] }
export const isWeChatRegistrationId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

/**
 * A forced re-login scanned a different bot identity than the target
 * registration (#5480). Nothing is saved and the strict identity check stays;
 * the typed cause lets the CLI explain the change and the safe continuation
 * instead of reporting a bare mismatch.
 */
export class WeChatIdentityMismatchError extends Error {
  constructor(readonly targetId: string, readonly registeredBotId: string, readonly scannedBotId: string) {
    super('Reauthentication must match the registered WeChat identity');
    this.name = 'WeChatIdentityMismatchError';
  }
}

/** Private account registry. Configuration enables the capability, never lists accounts. */
export class WeChatRegistry {
  constructor(readonly dir = DEFAULT_WECHAT_STATE_DIR) {}

  stateDir(account: WeChatRegistration): string {
    if (!isWeChatRegistrationId(account.id)) { throw new Error('Invalid WeChat registration ID'); }
    return account.legacy ? this.dir : join(this.dir, 'accounts', account.id);
  }

  channelId(account: WeChatRegistration): string { return account.legacy ? 'wechat' : `wechat:${account.id}`; }

  private async prepare(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.dir)).isDirectory()) { throw new Error('WeChat registry must be a real directory'); }
    await fs.chmod(this.dir, 0o700);
  }

  private async read(): Promise<RegistryDocument | undefined> {
    const file = join(this.dir, 'accounts.json');
    let text: string;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) { throw new Error('invalid file'); }
      await fs.chmod(file, 0o600);
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw new Error('Cannot read WeChat registry; repair or restore accounts.json');
    }
    try {
      const value = JSON.parse(text) as RegistryDocument;
      const ids = new Set<string>(); const bots = new Set<string>();
      if (value.version !== 1 || !Array.isArray(value.accounts)) { throw new Error(); }
      for (const account of value.accounts) {
        if (!account || !isWeChatRegistrationId(account.id) || !isWeChatRegistrationId(account.generation)
          || typeof account.botId !== 'string' || !account.botId || account.botId.length > 512
          || typeof account.enabled !== 'boolean' || !Number.isFinite(Date.parse(account.createdAt))
          || (account.legacy !== undefined && typeof account.legacy !== 'boolean')
          || ids.has(account.id) || bots.has(account.botId)) { throw new Error(); }
        ids.add(account.id); bots.add(account.botId);
      }
      if (value.accounts.filter(account => account.legacy).length > 1) { throw new Error(); }
      return value;
    } catch { throw new Error('Invalid WeChat registry; repair or restore accounts.json'); }
  }

  private async write(value: RegistryDocument): Promise<void> {
    const temp = join(this.dir, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, join(this.dir, 'accounts.json'));
    } finally { await fs.rm(temp, { force: true }); }
  }

  private async transaction<T>(update: (value: RegistryDocument) => Promise<T>): Promise<T> {
    await this.prepare();
    const guard = new WeChatStateStore(join(this.dir, '.registry-lock'));
    let release: (() => Promise<void>) | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { release = await guard.lock(); break; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes('already in use')) { throw error; }
        await delay(25);
      }
    }
    if (!release) { throw new Error('WeChat registry is busy; retry the operation'); }
    try {
      let value = await this.read();
      if (!value) {
        const old = await new WeChatStateStore(this.dir).loadCredentials();
        value = { version: 1, accounts: old ? [{ id: randomUUID(), botId: old.botId, enabled: true,
          generation: randomUUID(), createdAt: new Date().toISOString(), legacy: true }] : [] };
        // Persist even an empty registry: removing a legacy account must never reimport it.
        await this.write(value);
      }
      return await update(value);
    } finally { await release(); }
  }

  async list(): Promise<WeChatRegistration[]> { return await this.transaction(value => Promise.resolve(value.accounts)); }

  /** Commit only a completed login. No pending or failed QR flow becomes an account. */
  async register(credentials: WeChatCredentials, targetId?: string, expectedGeneration?: string): Promise<WeChatRegistration> {
    validateWechatBaseUrl(credentials.baseUrl);
    if (!credentials.token?.trim() || !credentials.botId || credentials.botId.length > 512) { throw new Error('Incomplete WeChat login'); }
    return await this.transaction(async value => {
      const target = targetId ? value.accounts.find(account => account.id === targetId) : undefined;
      if (targetId) {
        if (!target) { throw new Error('Reauthentication must match the registered WeChat identity'); }
        if (target.botId !== credentials.botId) { throw new WeChatIdentityMismatchError(targetId, target.botId, credentials.botId); }
      }
      if (expectedGeneration && target?.generation !== expectedGeneration) { throw new Error('Registration changed during login; retry'); }
      const existing = target ?? value.accounts.find(account => account.botId === credentials.botId);
      const account: WeChatRegistration = { ...(existing ?? { id: randomUUID(), createdAt: new Date().toISOString() }),
        botId: credentials.botId, enabled: true, generation: randomUUID() };
      const store = new WeChatStateStore(this.stateDir(account));
      let release: () => Promise<void>;
      try { release = await store.lock(); }
      catch { throw new Error('WeChat account is in use; disable this registration before reauthentication'); }
      try {
        await store.saveCredentials(credentials);
        value.accounts = [...value.accounts.filter(item => item.id !== account.id), account];
        await this.write(value);
        return account;
      } finally { await release(); }
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<WeChatRegistration> {
    return await this.transaction(async value => {
      const account = value.accounts.find(item => item.id === id);
      if (!account) { throw new Error('Unknown WeChat registration'); }
      account.enabled = enabled;
      account.generation = randomUUID();
      await this.write(value);
      return account;
    });
  }

  /** Forget the registration; retain its private state for explicit recovery, never auto-reload it. */
  async remove(id: string): Promise<void> {
    await this.transaction(async value => {
      if (!value.accounts.some(account => account.id === id)) { throw new Error('Unknown WeChat registration'); }
      value.accounts = value.accounts.filter(account => account.id !== id);
      await this.write(value);
    });
  }
}
