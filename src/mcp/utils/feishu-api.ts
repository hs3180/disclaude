/**
 * Feishu API utilities for sending messages.
 *
 * @module mcp/utils/feishu-api
 */

import * as lark from '@larksuiteoapi/node-sdk';

/**
 * Result of sending a message to Feishu.
 */
export interface SendMessageResult {
  messageId?: string;
}

/**
 * Send a message to Feishu chat.
 */
export async function sendMessageToFeishu(
  client: lark.Client,
  chatId: string,
  msgType: 'text' | 'interactive',
  content: string,
  parentId?: string
): Promise<SendMessageResult> {
  const messageData: {
    receive_id_type?: string;
    msg_type: string;
    content: string;
  } = {
    msg_type: msgType,
    content,
  };

  if (parentId) {
    const response = await client.im.message.reply({
      path: { message_id: parentId },
      data: messageData,
    });
    return { messageId: response?.data?.message_id };
  } else {
    const response = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, ...messageData },
    });
    return { messageId: response?.data?.message_id };
  }
}
