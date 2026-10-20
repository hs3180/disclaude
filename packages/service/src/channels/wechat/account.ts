import { join } from 'node:path';
import { DEFAULT_WECHAT_STATE_DIR } from './state-store.js';

export function validateWeChatAccountName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error('WeChat account name must be 1..64 letters, digits, underscores or hyphens, starting with a letter or digit');
  }
  return name;
}

export function wechatAccountStateDir(name?: string): string {
  return name ? join(DEFAULT_WECHAT_STATE_DIR, 'accounts', validateWeChatAccountName(name)) : DEFAULT_WECHAT_STATE_DIR;
}

/** Account-qualified IDs are stable across restarts and select the sending account. */
export function wechatChatId(account: string, peer: string): string {
  return `wechat:${validateWeChatAccountName(account)}:${peer}`;
}

export function wechatPeer(chatId: string, account?: string): string {
  if (!account) {
    if (chatId.startsWith('wechat:')) { throw new Error('This WeChat channel uses legacy, unqualified chat IDs'); }
    return chatId;
  }
  const prefix = `wechat:${validateWeChatAccountName(account)}:`;
  if (!chatId.startsWith(prefix) || !chatId.slice(prefix.length) || chatId.slice(prefix.length).includes(':')) {
    throw new Error(`Use an account-qualified chat ID: ${prefix}user@im.wechat`);
  }
  return chatId.slice(prefix.length);
}
