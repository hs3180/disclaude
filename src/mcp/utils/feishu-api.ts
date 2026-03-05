/**
 * Feishu API utilities for sending messages.
 *
 * @module mcp/utils/feishu-api
 */

import * as lark from '@larksuiteoapi/node-sdk';

/**
 * Send a message to Feishu chat.
 */
export async function sendMessageToFeishu(
  client: lark.Client,
  chatId: string,
  msgType: 'text' | 'interactive',
  content: string,
  parentId?: string
): Promise<void> {
  const messageData: {
    receive_id_type?: string;
    msg_type: string;
    content: string;
  } = {
    msg_type: msgType,
    content,
  };

  if (parentId) {
    await client.im.message.reply({
      path: { message_id: parentId },
      data: messageData,
    });
  } else {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, ...messageData },
    });
  }
}
