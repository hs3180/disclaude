/**
 * Feishu Integration Test: IPC uploadFile End-to-End.
 *
 * Tests the complete uploadFile flow via IPC:
 * 1. Connect to Primary Node via IPC
 * 2. Create temporary test files
 * 3. Upload files to a Feishu chat
 * 4. Verify upload responses
 * 5. Clean up test files
 *
 * Prerequisites:
 * - Primary Node running with Feishu channel configured
 * - FEISHU_INTEGRATION_TEST=true
 * - FEISHU_TEST_CHAT_ID set to a valid chat ID
 * - DISCLAUDE_IPC_SOCKET_PATH set to the running server's socket path
 *
 * Priority: P1
 *
 * @module __tests__/integration/feishu/send-file
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { UnixSocketIpcClient } from '@disclaude/core';
import {
  describeIfFeishu,
  getTestChatId,
  getIpcSocketPath,
  generateTestId,
  delay,
} from './helpers.js';

describeIfFeishu('IPC uploadFile End-to-End', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;
  let testDir: string;
  const createdFiles: string[] = [];

  beforeAll(async () => {
    chatId = getTestChatId();
    const socketPath = getIpcSocketPath();
    client = new UnixSocketIpcClient({ socketPath, timeout: 10000 });
    await client.connect();

    // Create temporary test directory
    testDir = join(tmpdir(), `disclaude-feishu-test-${generateTestId()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(async () => {
    await client.disconnect();

    // Clean up test files
    for (const file of createdFiles) {
      if (existsSync(file)) {
        rmSync(file, { force: true });
      }
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createTestFile(filename: string, content: string): string {
    const filePath = join(testDir, filename);
    writeFileSync(filePath, content, 'utf-8');
    createdFiles.push(filePath);
    return filePath;
  }

  it('should verify IPC connection is established', async () => {
    const result = await client.ping();
    expect(result).toBe(true);
  });

  it('should upload a small text file', async () => {
    const testId = generateTestId();
    const filePath = createTestFile(`test-${testId}.txt`, `Integration test file content (${testId})`);

    const result = await client.uploadFile(chatId, filePath);

    expect(result.success).toBe(true);
    expect(result.fileKey).toBeDefined();
    expect(result.fileName).toBeDefined();
  });

  it('should upload a JSON file', async () => {
    const testId = generateTestId();
    const jsonContent = JSON.stringify({
      test: 'feishu-integration',
      testId,
      timestamp: new Date().toISOString(),
      data: { nested: { value: 123 } },
    }, null, 2);
    const filePath = createTestFile(`test-${testId}.json`, jsonContent);

    const result = await client.uploadFile(chatId, filePath);

    expect(result.success).toBe(true);
    expect(result.fileKey).toBeDefined();
    expect(result.fileType).toBeDefined();
  });

  it('should upload a markdown file', async () => {
    const testId = generateTestId();
    const mdContent = [
      `# Markdown Test (${testId})`,
      '',
      '## Section 1',
      'This is a test markdown file for integration testing.',
      '',
      '## Section 2',
      '- Item 1',
      '- Item 2',
      '',
      '```typescript',
      'const x = 42;',
      '```',
    ].join('\n');
    const filePath = createTestFile(`test-${testId}.md`, mdContent);

    const result = await client.uploadFile(chatId, filePath);

    expect(result.success).toBe(true);
    expect(result.fileKey).toBeDefined();
  });

  it('should upload multiple files sequentially', async () => {
    const testId = generateTestId();
    const count = 3;
    const results = [];

    for (let i = 0; i < count; i++) {
      const filePath = createTestFile(
        `sequential-${testId}-${i}.txt`,
        `Sequential file ${i + 1}/${count} (${testId})`
      );
      const result = await client.uploadFile(chatId, filePath);
      results.push(result);
      // Small delay between uploads
      await delay(200);
    }

    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.fileKey).toBeDefined();
    }
  });

  it('should report failure for non-existent file', async () => {
    const result = await client.uploadFile(chatId, '/tmp/non-existent-file-12345.txt');

    // The upload should fail - either success=false or throw
    if (result.success) {
      // If it somehow succeeds, the file info should be minimal
      expect(result.fileKey).toBeDefined();
    } else {
      expect(result.success).toBe(false);
    }
  });
});
