/**
 * Topic group message notification event.
 *
 * Emitted when a message is received in a Feishu topic group (chat_type === 'topic').
 * Designed for real-time notification to connected clients, replacing polling-based
 * topic group monitoring.
 *
 * Issue #4031: Topic group message push notification via WebSocket broadcast.
 */
export interface TopicGroupMessageEvent {
  type: 'topic_group_message';
  /** Topic group chat ID (oc_xxx) */
  chatId: string;
  /** Root message ID of the thread */
  rootId: string;
  /** Thread/reply message ID */
  threadId: string;
  /** Sender information */
  sender: {
    /** Sender display name */
    name?: string;
    /** Sender open_id */
    openId?: string;
  };
  /** Message content summary (plain text) */
  content: string;
  /** Whether this message has a parent_id (i.e., is a reply within a thread, not the thread root) */
  isReply: boolean;
  /** ISO 8601 timestamp */
  timestamp: string;
}
