/**
 * Stable peer identity bindings for the WeChat channel (#5600).
 *
 * An iLink login expires server-side (getconfig -14 session timeout); the only
 * recovery is a fresh `disclaude wechat login`, which registers a new account
 * id and therefore a new `wechat:<id>` chatId prefix. Without a stable peer
 * binding, every re-registration forks each peer's conversation: the agent
 * pool, history and schedules key on the qualified chatId, which just changed.
 *
 * This store binds a *stable peer identifier* to the first qualified chatId
 * that served it. When a later registration receives a message from a peer
 * with the same stable id, the channel keeps emitting the original chatId, so
 * the existing session, history and schedules continue instead of forking.
 *
 * UNKNOWN (cannot be confirmed offline, #5600): whether a human peer's iLink
 * `from_user_id` is stable across the bot's re-registrations. The default
 * resolver returns that raw user id — the WeChat user id the issue asks to
 * bind identity to — and resolvers are injectable, so a confirmed stable
 * identifier can replace it without touching persistence or the channel.
 *
 * Bindings are scoped by the bot operator's WeChat user id (saved credentials
 * `userId`, already treated as stable across re-logins by #5480), so accounts
 * of different operators never share peers. While the registration that bound
 * a conversation is still serving in this process, another concurrently-live
 * registration of the same operator keeps its conversations isolated instead
 * of converging onto the bound chatId; continuation applies once the original
 * stops serving — the re-registration scenario this module exists for. Liveness
 * is per-process: operators running parallel bots for one WeChat user in
 * separate processes should inject a resolver that distinguishes them.
 *
 * @module channels/wechat/peer-identity
 * @see Issue #5600 - bind session identity to a stable WeChat user id
 */
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
/**
 * Default resolver: the raw iLink peer user id (`from_user_id`), i.e. the
 * WeChat user id. Its stability across the bot's re-registrations is UNKNOWN
 * (#5600); it is the best available candidate from code alone.
 */
export const wechatPeerUserIdResolver = (peer) => peer;
/** Scope used when the saved login carries no operator user id. */
export const WECHAT_PEER_SHARED_SCOPE = 'shared';
function validPeerIdentityBinding(value) {
    return typeof value === 'object' && value !== null
        && typeof value.stableId === 'string' && !!value.stableId && value.stableId.length <= 256
        && typeof value.scope === 'string' && !!value.scope && value.scope.length <= 256
        && typeof value.chatId === 'string' && !!value.chatId && value.chatId.length <= 512
        && typeof value.channelId === 'string' && !!value.channelId && value.channelId.length <= 256
        && typeof value.registrationId === 'string' && !!value.registrationId && value.registrationId.length <= 128
        && typeof value.boundAt === 'string' && Number.isFinite(Date.parse(value.boundAt));
}
function bindingKey(scope, stableId) { return `${scope}\u0000${stableId}`; }
/**
 * Cross-registration peer identity store. One JSON file per registry root,
 * shared by every account directory inside it; writes are atomic and
 * serialized per directory within this process. Channels must treat store
 * failures as non-fatal (fall back to the natural chatId) so identity-state
 * corruption never drops messages.
 */
export class WeChatPeerIdentityStore {
    dir;
    resolver;
    constructor(dir, resolver = wechatPeerUserIdResolver) {
        this.dir = dir;
        this.resolver = resolver;
    }
    async read() {
        let text;
        try {
            const file = join(this.dir, 'peer-identities.json');
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.size > 1024 * 1024) {
                throw new Error('invalid file');
            }
            await fs.chmod(file, 0o600);
            text = await fs.readFile(file, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return { version: 1, bindings: {} };
            }
            throw new Error('Cannot read WeChat peer identities; repair or restore peer-identities.json');
        }
        try {
            const value = JSON.parse(text);
            if (value.version !== 1 || !value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)
                || !Object.values(value.bindings).every(validPeerIdentityBinding)) {
                throw new Error();
            }
            return value;
        }
        catch {
            throw new Error('Invalid WeChat peer identities; repair or restore peer-identities.json');
        }
    }
    async write(value) {
        const content = JSON.stringify(value);
        if (Buffer.byteLength(content) > 1024 * 1024) {
            throw new Error('WeChat peer identities exceed private storage limit');
        }
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
        const temp = join(this.dir, `.${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' });
            await fs.rename(temp, join(this.dir, 'peer-identities.json'));
        }
        finally {
            await fs.rm(temp, { force: true });
        }
    }
    /** Serialized read-modify-write; one flight per directory in this process. */
    async update(change) {
        const previous = updateChains.get(this.dir) ?? Promise.resolve();
        const run = previous.catch(() => { }).then(async () => {
            const value = await this.read();
            const { result, dirty } = change(value);
            if (dirty) {
                await this.write(value);
            }
            return result;
        });
        updateChains.set(this.dir, run);
        return await run;
    }
    /**
     * Resolve the chatId a peer's messages must use on `registrationId`
     * (#5600). First sight binds the natural chatId; a later registration that
     * sees the same stable id continues the originally bound conversation. No
     * stable id → natural chatId, nothing persisted, behavior unchanged.
     */
    async continuePeer(args) {
        const stableId = this.resolver(args.peer);
        const natural = `${args.channelId}:${args.peer}`;
        if (!stableId) {
            return { chatId: natural, continued: false };
        }
        const scope = args.scope ?? WECHAT_PEER_SHARED_SCOPE;
        const key = bindingKey(scope, stableId);
        return await this.update((value) => {
            const binding = value.bindings[key];
            if (!binding) {
                value.bindings[key] = { stableId, scope, chatId: natural, channelId: args.channelId, registrationId: args.registrationId, boundAt: new Date().toISOString() };
                return { result: { chatId: natural, continued: false }, dirty: true };
            }
            if (binding.chatId === natural) {
                return { result: { chatId: natural, continued: false }, dirty: false };
            }
            // The bound conversation is still served by a concurrently-live
            // registration: keep this account's conversations isolated instead of
            // converging two live conversations onto one chatId. Continuation is
            // for re-registration (the original registration is gone), not for
            // accounts serving side by side.
            if (binding.channelId !== args.channelId && servingChannels.get(this.dir)?.has(binding.channelId)) {
                return { result: { chatId: natural, continued: false }, dirty: false };
            }
            return { result: { chatId: binding.chatId, continued: true, previousRegistrationId: binding.registrationId }, dirty: false };
        });
    }
    /** Read-only lookup for tests, CLI inspection and explicit migrations. */
    async loadBinding(peer, scope = WECHAT_PEER_SHARED_SCOPE) {
        const stableId = this.resolver(peer);
        if (!stableId) {
            return undefined;
        }
        return (await this.read()).bindings[bindingKey(scope, stableId)];
    }
}
const updateChains = new Map();
/**
 * Channels currently serving conversations per store directory, in this
 * process. A binding whose channel is still serving must not be continued by
 * another concurrently-live registration: the two accounts keep isolated
 * conversations (#5634 CI regression — two live accounts converged one peer
 * onto a single chatId whenever the first binding hit disk first). Channels
 * serving in *other* processes are not visible here; per-process liveness is
 * the strongest signal available offline.
 */
const servingChannels = new Map();
/** Record that `channelId` is actively serving conversations under `dir`. */
export function markWeChatChannelServing(dir, channelId) {
    let channels = servingChannels.get(dir);
    if (!channels) {
        channels = new Set();
        servingChannels.set(dir, channels);
    }
    channels.add(channelId);
}
/** Record that `channelId` stopped serving under `dir` (idempotent). */
export function unmarkWeChatChannelServing(dir, channelId) {
    const channels = servingChannels.get(dir);
    if (!channels) {
        return;
    }
    channels.delete(channelId);
    if (channels.size === 0) {
        servingChannels.delete(dir);
    }
}
