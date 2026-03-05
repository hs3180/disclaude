/**
 * Ruliu (如流) Platform Types.
 *
 * Type definitions for Ruliu platform integration.
 * Based on @chbo297/infoflow reference implementation.
 *
 * @see https://github.com/chbo297/openclaw-infoflow
 */

/**
 * Ruliu reply mode.
 * Controls how the bot responds to messages.
 */
export type RuliuReplyMode =
  | 'ignore'           // Discard messages
  | 'record'           // Only record, no reply
  | 'mention-only'     // Reply only when @mentioned
  | 'mention-and-watch' // @ + watch list + follow-up window (default)
  | 'proactive';       // Proactive participation

/**
 * Ruliu message body item types.
 */
export type RuliuMessageBodyItem =
  | { type: 'TEXT'; content: string }
  | { type: 'MD'; content: string }      // Markdown
  | { type: 'AT'; atall?: boolean; atuserids?: string[]; atagentids?: number[] }
  | { type: 'LINK'; href: string };

/**
 * Ruliu message event from webhook.
 */
export interface RuliuMessageEvent {
  /** Sender user ID */
  fromuser: string;
  /** Message content */
  mes: string;
  /** Chat type: direct message or group */
  chatType: 'direct' | 'group';
  /** Group ID (for group messages) */
  groupId?: number;
  /** Sender display name */
  senderName?: string;
  /** Whether bot was @mentioned */
  wasMentioned?: boolean;
  /** Message ID */
  messageId?: string;
  /** Message timestamp */
  timestamp?: number;
  /** Mention details */
  mentionIds?: {
    /** @mentioned user IDs */
    userIds: string[];
    /** @mentioned agent/robot IDs */
    agentIds: number[];
  };
}

/**
 * Ruliu API configuration.
 */
export interface RuliuConfig {
  /** API host (e.g., https://apiin.im.baidu.com) */
  apiHost: string;
  /** Verification token */
  checkToken: string;
  /** Message encryption key (Base64 encoded) */
  encodingAESKey: string;
  /** Application key */
  appKey: string;
  /** Application secret */
  appSecret: string;
  /** Robot name for @ detection */
  robotName: string;
  /** Reply mode (default: mention-and-watch) */
  replyMode?: RuliuReplyMode;
  /** Enable follow-up mode */
  followUp?: boolean;
  /** Follow-up window in seconds */
  followUpWindow?: number;
  /** Users to watch for mentions */
  watchMentions?: string[];
  /** Webhook path */
  webhookPath?: string;
}

/**
 * Ruliu send message request.
 */
export interface RuliuSendMessageRequest {
  /** Target chat ID (groupId for group, userId for direct) */
  chatId: string;
  /** Message body items */
  body: RuliuMessageBodyItem[];
  /** Message type */
  msgType: 'TEXT' | 'MD';
}

/**
 * Ruliu API response.
 */
export interface RuliuApiResponse<T = unknown> {
  /** Error code (0 means success) */
  errcode: number;
  /** Error message */
  errmsg: string;
  /** Response data */
  data?: T;
}

/**
 * Ruliu webhook encrypted message.
 */
export interface RuliuEncryptedMessage {
  /** Encrypted content */
  encrypt: string;
  /** Message signature */
  signature: string;
  /** Timestamp */
  timestamp: string;
  /** Nonce */
  nonce: string;
}

/**
 * Ruliu decrypted message content.
 */
export interface RuliuDecryptedContent {
  /** Message content */
  content: string;
  /** Sender user ID */
  fromUsername: string;
  /** Message type */
  msgType: string;
  /** Chat ID */
  chatId: string;
  /** Group ID (if group message) */
  groupId?: string;
  /** Message ID */
  msgId: string;
  /** Timestamp */
  createTime: number;
}
