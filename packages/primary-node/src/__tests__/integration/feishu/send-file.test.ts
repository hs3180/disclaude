/**
 * Feishu Integration Tests: file upload and send end-to-end.
 *
 * Tests the IPC sendFile complete chain via the real Feishu API:
 * 1. Upload an image and send it to the test chat
 * 2. Upload a file and send it to the test chat
 * 3. Verify the API responses contain valid keys
 *
 * Priority: P1 (Issue #1626)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIfFeishu,
  getTestChatId,
  getTestClient,
  allowFeishuHosts,
  extractMessageId,
  testMarker,
} from './helpers.js';

/** Minimal valid PNG file (1x1 pixel, transparent) */
const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c62000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

describeIfFeishu('Feishu Integration: sendFile', () => {
  let client: ReturnType<typeof getTestClient>;
  let chatId: string;
  const tempFiles: string[] = [];

  beforeAll(() => {
    allowFeishuHosts();
    client = getTestClient();
    chatId = getTestChatId();
  });

  afterAll(() => {
    // Clean up temp files
    for (const f of tempFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('image upload and send', () => {
    it('should upload an image and receive a valid image_key', async () => {
      const imagePath = path.join(os.tmpdir(), `feishu_test_${Date.now()}.png`);
      fs.writeFileSync(imagePath, MINIMAL_PNG);
      tempFiles.push(imagePath);

      const imageStream = fs.createReadStream(imagePath);
      const uploadResponse = await client.im.image.create({
        data: { image_type: 'message', image: imageStream },
      });

      expect(uploadResponse).toBeDefined();
      const imageKey = (uploadResponse as { data?: { image_key?: string } })?.data?.image_key;
      expect(imageKey).toBeTruthy();
      expect(typeof imageKey).toBe('string');
    });

    it('should upload an image and send it as a message', async () => {
      const imagePath = path.join(os.tmpdir(), `feishu_send_${Date.now()}.png`);
      fs.writeFileSync(imagePath, MINIMAL_PNG);
      tempFiles.push(imagePath);

      // Upload image
      const imageStream = fs.createReadStream(imagePath);
      const uploadResponse = await client.im.image.create({
        data: { image_type: 'message', image: imageStream },
      });

      const imageKey = (uploadResponse as { data?: { image_key?: string } })?.data?.image_key;
      expect(imageKey).toBeTruthy();

      // Send image message
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });

      const messageId = extractMessageId(response);
      expect(messageId).toBeTruthy();
    });
  });

  describe('file upload and send', () => {
    it('should upload a file and receive a valid file_key', async () => {
      const filePath = path.join(os.tmpdir(), `feishu_test_${Date.now()}.txt`);
      fs.writeFileSync(filePath, testMarker('file-upload'));
      tempFiles.push(filePath);

      const fileStream = fs.createReadStream(filePath);
      const uploadResponse = await client.im.file.create({
        data: { file_type: 'stream', file_name: 'test.txt', file: fileStream },
      });

      expect(uploadResponse).toBeDefined();
      const fileKey = (uploadResponse as { data?: { file_key?: string } })?.data?.file_key;
      expect(fileKey).toBeTruthy();
      expect(typeof fileKey).toBe('string');
    });

    it('should upload a file and send it as a message', async () => {
      const filePath = path.join(os.tmpdir(), `feishu_send_${Date.now()}.txt`);
      fs.writeFileSync(filePath, testMarker('file-send-message'));
      tempFiles.push(filePath);

      // Upload file
      const fileStream = fs.createReadStream(filePath);
      const uploadResponse = await client.im.file.create({
        data: { file_type: 'stream', file_name: 'integration-test.txt', file: fileStream },
      });

      const fileKey = (uploadResponse as { data?: { file_key?: string } })?.data?.file_key;
      expect(fileKey).toBeTruthy();

      // Send file message
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      const messageId = extractMessageId(response);
      expect(messageId).toBeTruthy();
    });
  });

  describe('mixed content message', () => {
    it('should send a post (rich text) message', async () => {
      const postContent = {
        zh_cn: {
          title: testMarker('post-message'),
          content: [
            [
              { tag: 'text', text: 'Integration test post message. ' },
              { tag: 'a', text: 'Link', href: 'https://example.com' },
            ],
            [
              { tag: 'at', user_id: 'all' },
              { tag: 'text', text: ' — automated test, please ignore.' },
            ],
          ],
        },
      };

      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify(postContent),
        },
      });

      const messageId = extractMessageId(response);
      expect(messageId).toBeTruthy();
    });
  });
});
