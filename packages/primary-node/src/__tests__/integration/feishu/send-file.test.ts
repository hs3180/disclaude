/**
 * P1 Integration Test: Feishu file upload and sending (end-to-end).
 *
 * Tests the complete flow of uploading and sending a file via the real Feishu API:
 * 1. Create a temporary test file
 * 2. Upload the file using the Feishu im.file.create API
 * 3. Send the file as a message to the test chat
 * 4. Verify the API response
 * 5. Clean up the temporary file
 *
 * **Prerequisites:**
 * - `FEISHU_INTEGRATION_TEST=true`
 * - `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
 * - `FEISHU_TEST_CHAT_ID`
 *
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1634 - MCP send_file tool test (HTTP 000)
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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

describeIfFeishu('Feishu Integration: file upload and sending', () => {
  let client: lark.Client;
  let testChatId: string;
  let tempDir: string;
  let tempFiles: string[];

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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-integration-'));
    tempFiles = [];
  });

  afterAll(() => {
    blockFeishuNetwork();

    // Clean up temporary files
    for (const filePath of tempFiles) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }
    }
    try {
      fs.rmdirSync(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper to create a temporary test file.
   */
  function createTempFile(content: string, ext: string = '.txt'): string {
    const testMarker = generateTestMarker();
    const filePath = path.join(tempDir, `test-${testMarker}${ext}`);
    fs.writeFileSync(filePath, content);
    tempFiles.push(filePath);
    return filePath;
  }

  it('should upload a file and send it as a message', async () => {
    const fileContent = `${generateTestMarker()} Integration test file content. Safe to ignore.`;
    const filePath = createTempFile(fileContent, '.pdf');

    // Step 1: Upload the file (file_type must be one of: opus, mp4, pdf, doc, xls, ppt, stream)
    const uploadResponse = await client.im.file.create({
      data: {
        file_type: 'pdf',
        file_name: path.basename(filePath),
        file: fs.createReadStream(filePath),
      },
    });

    expect(uploadResponse).toBeDefined();
    expect(uploadResponse).not.toBeNull();

    // im.file.create response has file_key at top level (not wrapped in data)
    const fileKey = uploadResponse?.file_key;
    expect(fileKey).toBeDefined();
    expect(typeof fileKey).toBe('string');

    // Step 2: Send the file as a message
    const sendResponse = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: testChatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });

    expect(sendResponse).toBeDefined();
    expect(sendResponse?.data?.message_id).toBeDefined();
  });

  it('should upload a stream-type file', async () => {
    const fileContent = `${generateTestMarker()} Test stream content.`;
    const filePath = createTempFile(fileContent, '.bin');

    const uploadResponse = await client.im.file.create({
      data: {
        file_type: 'stream',
        file_name: path.basename(filePath),
        file: fs.createReadStream(filePath),
      },
    });

    expect(uploadResponse).toBeDefined();
    expect(uploadResponse?.file_key).toBeDefined();
  });
});
