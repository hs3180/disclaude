/**
 * P1 Integration Test: Feishu text message sending (end-to-end).
 *
 * Tests the complete flow of sending a text message via the real Feishu API:
 * 1. Create a Feishu SDK client with real credentials
 * 2. Send a text message to the test chat
 * 3. Verify the API response
 *
 * **Prerequisites:**
 * - `FEISHU_INTEGRATION_TEST=true`
 * - `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
 * - `FEISHU_TEST_CHAT_ID`
 *
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  describeIfFeishu,
  allowFeishuNetwork,
  blockFeishuNetwork,
  getFeishuAppId,
  getFeishuAppSecret,
  getTestChatId,
  generateTestMarker,
} from './helpers.js';

describeIfFeishu('Feishu Integration: sendMessage end-to-end', () => {
  let client: lark.Client;
  let testChatId: string;

  beforeAll(() => {
    allowFeishuNetwork();

    const appId = getFeishuAppId();
    const appSecret = getFeishuAppSecret();
    testChatId = getTestChatId();

    client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
    });
  });

  afterAll(() => {
    blockFeishuNetwork();
  });

  it('should send a plain text message via real Feishu API', async () => {
    const testMarker = generateTestMarker();
    const text = `${testMarker} Integration test: plain text message. Safe to ignore.`;

    const response = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: testChatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });

    expect(response).toBeDefined();
    expect(response).not.toBeNull();
    const messageId = response?.data?.message_id;
    expect(messageId).toBeDefined();
    expect(typeof messageId).toBe('string');
  });

  it('should send a message with special characters', async () => {
    const testMarker = generateTestMarker();
    const text = `${testMarker} Special chars: 你好世界 🌍 <>&"'\n\t`;

    const response = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: testChatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });

    expect(response).toBeDefined();
    expect(response?.data?.message_id).toBeDefined();
  });

  it('should send a long text message', async () => {
    const testMarker = generateTestMarker();
    // Feishu text messages can be quite long
    const longText = `${testMarker} Long message test: ` + ' Lorem ipsum '.repeat(100);

    const response = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: testChatId,
        msg_type: 'text',
        content: JSON.stringify({ text: longText }),
      },
    });

    expect(response).toBeDefined();
    expect(response?.data?.message_id).toBeDefined();
  });
});
