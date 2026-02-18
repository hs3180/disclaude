/**
 * Feishu message event structure.
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/events/receive_v1
 */
export interface FeishuMessageEvent {
  message: {
    message_id: string;
    chat_id: string;
    content: string;
    message_type: string;
    create_time?: number;
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
    parent_id?: string;
    root_id?: string;
    thread_id?: string;
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
 * Feishu WebSocket event data wrapper.
 */
export interface FeishuEventData {
  event?: FeishuMessageEvent;
  [key: string]: unknown;
}
