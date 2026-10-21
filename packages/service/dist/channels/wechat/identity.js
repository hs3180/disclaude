import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rmdir } from 'node:fs/promises';
import { WeChatStateStore } from './state-store.js';
import { isWeChatRegistrationId } from './registry.js';
export function wechatChannelId(id) {
    if (!isWeChatRegistrationId(id)) {
        throw new Error('Invalid WeChat registration ID');
    }
    return `wechat:${id}`;
}
export function wechatPeer(chatId, id) {
    if (!id && !chatId.startsWith('wechat:')) {
        return chatId;
    }
    const prefix = id ? `${wechatChannelId(id)}:` : '';
    const peer = chatId.slice(prefix.length);
    if (!chatId.startsWith(prefix) || !/^[\w.-]{1,128}@im\.wechat$/.test(peer)) {
        throw new Error('Use the conversation ID from this WeChat registration');
    }
    return peer;
}
/** Saved copies of one real bot must not compete for its long-poll stream. */
export async function lockWeChatIdentity(botId, root = join(homedir(), '.disclaude', 'wechat-listener-locks')) {
    const dir = join(root, createHash('sha256').update(botId).digest('hex'));
    const release = await new WeChatStateStore(dir).lock();
    return async () => { await release(); await rmdir(dir).catch(() => { }); };
}
