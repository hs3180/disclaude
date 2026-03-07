/**
 * Feishu message event structure.
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/events/receive_v1
 */
export interface FeishuMessageEvent {
  message: {
    message_id: string;
    chat_id: string;
    chat_type?: 'p2p' | 'group' | 'topic';
    content: string;
    message_type: string;
    create_time?: number;
    /**
     * Root message ID for reply threads.
     * Present when this message is a reply to another message.
     * Issue #846: Support reading quoted/reply message content
     */
    root_id?: string;
    /**
     * Parent message ID for nested replies.
     * Present when this message is a reply to another message.
     * Issue #846: Support reading quoted/reply message content
     */
    parent_id?: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id: string;
        union_id: string;
        user_id: string;
      };
      name: string;
      tenant_key: string;
    }>;
  };
  sender: {
    sender_type?: string;
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    tenant_key?: string;
  };
}

/**
 * Chat record message structure for forwarded/packed conversations.
 * Issue #846: Support reading packed conversation records
 */
export interface FeishuChatRecordContent {
  /** List of messages in the packed conversation */
  messages: Array<{
    message_id: string;
    content: string;
    message_type: string;
    create_time?: number;
    sender?: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
      };
    };
  }>;
}

/**
 * Parsed chat record message with extracted text content.
 * Issue #846: Support reading packed conversation records
 */
export interface ParsedChatRecord {
  /** Original messages from the packed conversation */
  messages: Array<{
    senderId?: string;
    content: string;
    timestamp?: number;
  }>;
  /** Formatted text representation for AI context */
  formattedText: string;
}

/**
 * Feishu WebSocket event data wrapper.
 */
export interface FeishuEventData {
  event?: FeishuMessageEvent;
  [key: string]: unknown;
}

/**
 * Feishu card action event structure.
 * Triggered when user interacts with card buttons, menus, etc.
 * @see https://open.feishu.cn/document/client-docs/bot-v3/events/card-action-trigger
 */
export interface FeishuCardActionEvent {
  /** The action that was triggered */
  action: {
    /** Action type: button, menu, date_picker, etc. */
    type: string;
    /** Action value set when creating the card */
    value: string;
    /** What triggered the action: button, menu, date, etc. */
    trigger: 'button' | 'menu' | 'date' | 'input' | 'static';
    /** For menu/dropdown: the selected option */
    option?: string;
    /**
     * Button or option text displayed to user.
     * Used to generate user-friendly prompt when action is triggered.
     * Issue #525: Simple card interaction without promptTemplate
     */
    text?: string;
  };
  /** The message containing the card */
  message_id: string;
  /** Chat ID */
  chat_id: string;
  /** User who triggered the action */
  user: {
    sender_id: {
      open_id: string;
      union_id?: string;
      user_id?: string;
    };
  };
  /** Tenant key */
  tenant_key?: string;
  /** Token for updating the card */
  token?: string;
  /** Open message ID for card update */
  open_message_id?: string;
  /** Open card ID */
  open_card_id?: string;
}

/**
 * Feishu card action event data wrapper.
 */
export interface FeishuCardActionEventData {
  event?: FeishuCardActionEvent;
  [key: string]: unknown;
}

/**
 * Interaction context stored for pending interactions.
 */
export interface InteractionContext {
  /** Unique interaction ID */
  id: string;
  /** Chat ID where interaction was created */
  chatId: string;
  /** Message ID of the card */
  messageId: string;
  /** Action keys expected in this interaction */
  expectedActions: string[];
  /** Timestamp when interaction was created */
  createdAt: number;
  /** Timestamp when interaction expires */
  expiresAt: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Callback to handle the interaction */
  handler?: (action: FeishuCardActionEvent) => Promise<void>;
}

/**
 * Interaction handler function type.
 */
export type InteractionHandler = (action: FeishuCardActionEvent) => Promise<void>;

/**
 * Feishu chat member added event.
 * Triggered when members (including bot) are added to a chat.
 * @see https://open.feishu.cn/document/client-docs/bot-v3/events/chat-member-added
 */
export interface FeishuChatMemberAddedEvent {
  /** Chat ID */
  chat_id: string;
  /** Timestamp */
  timestamp: string;
  /** Members added to the chat */
  members: Array<{
    member_id_type: string;
    member_id: string;
    name?: string;
    tenant_key?: string;
  }>;
  /** Operator who added the members */
  operator: {
    operator_id_type: string;
    operator_id: string;
    tenant_key?: string;
  };
}

/**
 * Feishu chat member added event data wrapper.
 */
export interface FeishuChatMemberAddedEventData {
  event?: FeishuChatMemberAddedEvent;
  [key: string]: unknown;
}

/**
 * Feishu P2P chat entered event.
 * Triggered when a user starts a private chat with the bot.
 * @see https://open.feishu.cn/document/client-docs/bot-v3/events/bot-p2p-chat-entered
 */
export interface FeishuP2PChatEnteredEvent {
  /** User who entered the chat */
  user: {
    open_id: string;
    union_id?: string;
    user_id?: string;
    tenant_key?: string;
  };
  /** Timestamp */
  timestamp: string;
}

/**
 * Feishu P2P chat entered event data wrapper.
 */
export interface FeishuP2PChatEnteredEventData {
  event?: FeishuP2PChatEnteredEvent;
  [key: string]: unknown;
}
