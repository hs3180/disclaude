import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_WECHAT_STATE_DIR, WeChatStateStore, validateWechatBaseUrl } from './state-store.js';
import { autoRecoverRegistryLock } from './registry-lock-recovery.js';
let quarantineWarn;
const logQuarantine = (fields, message) => {
    if (quarantineWarn) {
        quarantineWarn(fields, message);
        return;
    }
    void import("../../../../core/dist/index.js")
        .then(({ createLogger }) => {
        const logger = createLogger('WeChatRegistry');
        quarantineWarn = (innerFields, innerMessage) => logger.warn(innerFields, innerMessage);
        quarantineWarn(fields, message);
    })
        .catch(() => { });
};
export const isWeChatRegistrationId = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
/**
 * A forced re-login scanned a different bot identity than the target
 * registration (#5480). Nothing is saved and the strict identity check stays;
 * the typed cause lets the CLI explain the change and the safe continuation
 * instead of reporting a bare mismatch.
 */
export class WeChatIdentityMismatchError extends Error {
    targetId;
    registeredBotId;
    scannedBotId;
    constructor(targetId, registeredBotId, scannedBotId) {
        super('Reauthentication must match the registered WeChat identity');
        this.targetId = targetId;
        this.registeredBotId = registeredBotId;
        this.scannedBotId = scannedBotId;
        this.name = 'WeChatIdentityMismatchError';
    }
}
/** Private account registry. Configuration enables the capability, never lists accounts. */
export class WeChatRegistry {
    dir;
    constructor(dir = DEFAULT_WECHAT_STATE_DIR) {
        this.dir = dir;
    }
    stateDir(account) {
        if (!isWeChatRegistrationId(account.id)) {
            throw new Error('Invalid WeChat registration ID');
        }
        return account.legacy ? this.dir : join(this.dir, 'accounts', account.id);
    }
    channelId(account) { return account.legacy ? 'wechat' : `wechat:${account.id}`; }
    async prepare() {
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
        if (!(await fs.lstat(this.dir)).isDirectory()) {
            throw new Error('WeChat registry must be a real directory');
        }
        await fs.chmod(this.dir, 0o700);
    }
    async read() {
        const file = join(this.dir, 'accounts.json');
        let text;
        try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.size > 1024 * 1024) {
                throw new Error('invalid file');
            }
            await fs.chmod(file, 0o600);
            text = await fs.readFile(file, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return undefined;
            }
            throw new Error('Cannot read WeChat registry; repair or restore accounts.json');
        }
        try {
            const value = JSON.parse(text);
            const ids = new Set();
            const bots = new Set();
            if (value.version !== 1 || !Array.isArray(value.accounts)) {
                throw new Error();
            }
            for (const account of value.accounts) {
                if (!account || !isWeChatRegistrationId(account.id) || !isWeChatRegistrationId(account.generation)
                    || typeof account.botId !== 'string' || !account.botId || account.botId.length > 512
                    || typeof account.enabled !== 'boolean' || !Number.isFinite(Date.parse(account.createdAt))
                    || (account.legacy !== undefined && typeof account.legacy !== 'boolean')
                    || ids.has(account.id) || bots.has(account.botId)) {
                    throw new Error();
                }
                ids.add(account.id);
                bots.add(account.botId);
            }
            if (value.accounts.filter(account => account.legacy).length > 1) {
                throw new Error();
            }
            return value;
        }
        catch {
            throw new Error('Invalid WeChat registry; repair or restore accounts.json');
        }
    }
    async write(value) {
        const temp = join(this.dir, `.${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
            await fs.rename(temp, join(this.dir, 'accounts.json'));
        }
        finally {
            await fs.rm(temp, { force: true });
        }
    }
    async transaction(update) {
        await this.prepare();
        const guard = new WeChatStateStore(join(this.dir, '.registry-lock'));
        let release;
        let quarantined = false;
        for (let attempt = 0; attempt < 40; attempt++) {
            try {
                release = await guard.lock();
                break;
            }
            catch (error) {
                if (!(error instanceof Error)) {
                    throw error;
                }
                if (error.message.includes('already in use')) {
                    await delay(25);
                    continue;
                }
                if (!error.message.includes('Invalid WeChat listener lock')) {
                    throw error;
                }
                // #5513: an empty or malformed guard lock (e.g. ENOSPC residue) must not
                // keep every registry operation failing. Quarantine the residue and let
                // the next attempt rebuild the lock; unsafe files still fail loudly below.
                const recovery = await autoRecoverRegistryLock(this.dir);
                if (recovery.outcome === 'quarantined') {
                    quarantined = true;
                    logQuarantine({ code: 'wechat_registry_lock_corrupt', registryRoot: recovery.registryRoot,
                        quarantinePath: recovery.quarantinePath, bytes: recovery.bytes, sha256: recovery.sha256,
                        corruption: recovery.state }, 'WeChat registry lock was empty or corrupt; quarantined the residue and rebuilt the lock automatically');
                }
            }
        }
        if (!release) {
            throw new Error(quarantined
                ? 'WeChat registry lock stays corrupt after automatic quarantine; run disclaude wechat lock-inspect and repair its state'
                : 'WeChat registry is busy; retry the operation');
        }
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
        }
        finally {
            await release();
        }
    }
    async list() { return await this.transaction(value => Promise.resolve(value.accounts)); }
    /** Commit only a completed login. No pending or failed QR flow becomes an account. */
    async register(credentials, targetId, expectedGeneration) {
        validateWechatBaseUrl(credentials.baseUrl);
        if (!credentials.token?.trim() || !credentials.botId || credentials.botId.length > 512) {
            throw new Error('Incomplete WeChat login');
        }
        return await this.transaction(async (value) => {
            const target = targetId ? value.accounts.find(account => account.id === targetId) : undefined;
            if (targetId) {
                if (!target) {
                    throw new Error('Reauthentication must match the registered WeChat identity');
                }
                if (target.botId !== credentials.botId) {
                    // #5480 (maintainer review on #5662): a registration's identity is
                    // its WeChat-server-provided user id, not the command-line --id
                    // binding. A confirmed scan from that same user rebinds the bot
                    // identity in place; any other scan still fails closed here.
                    const saved = credentials.userId ? await new WeChatStateStore(this.stateDir(target)).loadCredentials() : undefined;
                    if (!saved?.userId || saved.userId !== credentials.userId) {
                        throw new WeChatIdentityMismatchError(targetId, target.botId, credentials.botId);
                    }
                }
            }
            if (expectedGeneration && target?.generation !== expectedGeneration) {
                throw new Error('Registration changed during login; retry');
            }
            const existing = target ?? value.accounts.find(account => account.botId === credentials.botId)
                ?? await this.findRegisteredUser(value.accounts, credentials.userId);
            const account = { ...(existing ?? { id: randomUUID(), createdAt: new Date().toISOString() }),
                botId: credentials.botId, enabled: true, generation: randomUUID() };
            const store = new WeChatStateStore(this.stateDir(account));
            let release;
            try {
                release = await store.lock();
            }
            catch {
                throw new Error('WeChat account is in use; disable this registration before reauthentication');
            }
            try {
                await store.saveCredentials(credentials);
                value.accounts = [...value.accounts.filter(item => item.id !== account.id), account];
                await this.write(value);
                return account;
            }
            finally {
                await release();
            }
        });
    }
    /**
     * #5480 (maintainer review on #5662): whether a newly scanned user already
     * exists is judged from the WeChat-server-provided user id, so a returning
     * user's fresh scan lands on their registration instead of registering a
     * parallel account. Registrations saved without a user id never match.
     */
    async findRegisteredUser(accounts, userId) {
        if (!userId) {
            return undefined;
        }
        for (const account of accounts) {
            const saved = await new WeChatStateStore(this.stateDir(account)).loadCredentials();
            if (saved?.userId === userId) {
                return account;
            }
        }
        return undefined;
    }
    async setEnabled(id, enabled) {
        return await this.transaction(async (value) => {
            const account = value.accounts.find(item => item.id === id);
            if (!account) {
                throw new Error('Unknown WeChat registration');
            }
            account.enabled = enabled;
            account.generation = randomUUID();
            await this.write(value);
            return account;
        });
    }
    /** Forget the registration; retain its private state for explicit recovery, never auto-reload it. */
    async remove(id) {
        await this.transaction(async (value) => {
            if (!value.accounts.some(account => account.id === id)) {
                throw new Error('Unknown WeChat registration');
            }
            value.accounts = value.accounts.filter(account => account.id !== id);
            await this.write(value);
        });
    }
}
