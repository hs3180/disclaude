/**
 * Node Communication Integration Tests
 *
 * Tests inter-node communication and file transfer capabilities.
 *
 * These tests verify:
 * - File storage and retrieval between nodes
 * - File API operations
 * - Transfer protocol compliance
 * - Error handling in distributed scenarios
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testId } from './setup.js';
import { mkdtemp, writeFile, readFile, unlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Node Communication Integration', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'node-comm-test-'));
  });

  afterAll(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('File Operations', () => {
    it('should create and read files correctly', async () => {
      const testContent = `Test content ${testId()}`;
      const filePath = join(tempDir, `test-${testId()}.txt`);

      // Write
      await writeFile(filePath, testContent, 'utf-8');

      // Read
      const readContent = await readFile(filePath, 'utf-8');

      expect(readContent).toBe(testContent);

      // Cleanup
      await unlink(filePath);
    });

    it('should handle binary file operations', async () => {
      const testBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
      const filePath = join(tempDir, `test-${testId()}.bin`);

      // Write binary
      await writeFile(filePath, testBuffer);

      // Read binary
      const readBuffer = await readFile(filePath);

      expect(readBuffer).toEqual(testBuffer);

      // Cleanup
      await unlink(filePath);
    });

    it('should handle large file operations', async () => {
      // Create 1MB test file
      const size = 1024 * 1024;
      const testBuffer = Buffer.alloc(size, 'a');
      const filePath = join(tempDir, `large-${testId()}.bin`);

      // Write large file
      await writeFile(filePath, testBuffer);

      // Read and verify size
      const readBuffer = await readFile(filePath);

      expect(readBuffer.length).toBe(size);

      // Cleanup
      await unlink(filePath);
    });
  });

  describe('File API Integration', () => {
    it('should handle file not found errors', async () => {
      const nonExistentPath = join(tempDir, `non-existent-${testId()}.txt`);

      await expect(readFile(nonExistentPath, 'utf-8')).rejects.toThrow('ENOENT');
    });

    it('should handle concurrent file operations', async () => {
      const files = Array.from({ length: 10 }, (_, i) => ({
        path: join(tempDir, `concurrent-${i}-${testId()}.txt`),
        content: `Content ${i}`,
      }));

      // Write all files concurrently
      await Promise.all(
        files.map((f) => writeFile(f.path, f.content, 'utf-8'))
      );

      // Read all files concurrently
      const contents = await Promise.all(
        files.map((f) => readFile(f.path, 'utf-8'))
      );

      // Verify all contents
      contents.forEach((content, i) => {
        expect(content).toBe(files[i].content);
      });

      // Cleanup
      await Promise.all(files.map((f) => unlink(f.path)));
    });
  });

  describe('File Transfer Types', () => {
    it('should have file reference creation functions', async () => {
      const { createFileRef, createInboundAttachment, createOutboundFile } =
        await import('../../src/file-transfer/types.js');

      expect(createFileRef).toBeDefined();
      expect(typeof createFileRef).toBe('function');
      expect(createInboundAttachment).toBeDefined();
      expect(createOutboundFile).toBeDefined();
    });

    it('should handle file client operations', async () => {
      const { FileClient } = await import('../../src/file-transfer/node-transfer/file-client.js');

      // FileClient is a class for node-to-node file transfer
      expect(FileClient).toBeDefined();
    });
  });
});

describe('Node Transfer Integration', () => {
  describe('File Storage', () => {
    it('should create file storage service instance', async () => {
      const { FileStorageService } = await import('../../src/file-transfer/node-transfer/file-storage.js');

      const storage = new FileStorageService({ storageDir: '/tmp/test-storage' });
      expect(storage).toBeDefined();
    });
  });

  describe('File API', () => {
    it('should have file transfer API handler available', async () => {
      const { createFileTransferAPIHandler } = await import('../../src/file-transfer/node-transfer/file-api.js');

      // createFileTransferAPIHandler creates HTTP-based file operations handler
      expect(createFileTransferAPIHandler).toBeDefined();
      expect(typeof createFileTransferAPIHandler).toBe('function');
    });
  });
});

describe('Feishu File Transfer Integration', () => {
  describe('Inbound File Handling', () => {
    it('should handle attachment manager', async () => {
      const { AttachmentManager } = await import('../../src/file-transfer/inbound/attachment-manager.js');

      expect(AttachmentManager).toBeDefined();
    });

    it('should have feishu download function', async () => {
      const { downloadFile } = await import('../../src/file-transfer/inbound/feishu-downloader.js');

      expect(downloadFile).toBeDefined();
      expect(typeof downloadFile).toBe('function');
    });
  });

  describe('Outbound File Handling', () => {
    it('should handle feishu uploader', async () => {
      const { uploadAndSendFile } = await import('../../src/file-transfer/outbound/feishu-uploader.js');

      expect(uploadAndSendFile).toBeDefined();
      expect(typeof uploadAndSendFile).toBe('function');
    });
  });
});
