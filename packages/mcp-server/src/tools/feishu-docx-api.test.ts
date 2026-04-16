/**
 * Tests for Feishu Document API utilities (packages/mcp-server/src/tools/feishu-docx-api.ts)
 *
 * Tests the low-level API wrappers for the 3-step document image insertion flow.
 * Uses nock for HTTP request interception.
 *
 * Issue #2278: Support inline image insertion in Feishu documents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';

import {
  getTenantAccessToken,
  createImageBlock,
  uploadDocxImage,
  replaceImageBlock,
  clearTokenCache,
} from './feishu-docx-api.js';

const FEISHU_API = 'https://open.feishu.cn';

describe('feishu-docx-api', () => {
  beforeEach(() => {
    clearTokenCache();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('getTenantAccessToken', () => {
    it('should obtain and return a tenant access token', async () => {
      nock(FEISHU_API)
        .post('/open-apis/auth/v3/tenant_access_token/internal')
        .reply(200, {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'token-abc-123',
          expire: 7200,
        });

      const token = await getTenantAccessToken('app-id', 'app-secret');
      expect(token).toBe('token-abc-123');
    });

    it('should cache the token and reuse it', async () => {
      nock(FEISHU_API)
        .post('/open-apis/auth/v3/tenant_access_token/internal')
        .reply(200, {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'cached-token',
          expire: 7200,
        });

      const token1 = await getTenantAccessToken('app-id', 'app-secret');
      const token2 = await getTenantAccessToken('app-id', 'app-secret');
      expect(token1).toBe('cached-token');
      expect(token2).toBe('cached-token');
      // Only one API call should have been made
      expect(nock.isDone()).toBe(true);
    });

    it('should throw on auth failure', async () => {
      nock(FEISHU_API)
        .post('/open-apis/auth/v3/tenant_access_token/internal')
        .reply(200, { code: 10014, msg: 'invalid app_id' });

      await expect(getTenantAccessToken('bad-id', 'bad-secret'))
        .rejects.toThrow('Feishu auth error 10014');
    });

    it('should throw on HTTP error', async () => {
      nock(FEISHU_API)
        .post('/open-apis/auth/v3/tenant_access_token/internal')
        .reply(500);

      await expect(getTenantAccessToken('app-id', 'app-secret'))
        .rejects.toThrow('Failed to get tenant access token');
    });
  });

  describe('createImageBlock', () => {
    it('should create an empty image block and return block_id', async () => {
      nock(FEISHU_API)
        .post('/open-apis/docx/v1/documents/doc123/blocks/doc123/children', (body) => {
          expect(body.children).toHaveLength(1);
          expect(body.children[0].block_type).toBe(27);
          expect(body.index).toBe(3);
          return true;
        })
        .reply(200, {
          code: 0,
          msg: 'ok',
          data: {
            children: [{ block_id: 'blk_456', block_type: 27 }],
          },
        });

      const blockId = await createImageBlock('test-token', 'doc123', 3);
      expect(blockId).toBe('blk_456');
    });

    it('should throw when API returns error code', async () => {
      nock(FEISHU_API)
        .post('/open-apis/docx/v1/documents/doc999/blocks/doc999/children')
        .reply(200, { code: 10010, msg: 'document not found' });

      await expect(createImageBlock('test-token', 'doc999', 0))
        .rejects.toThrow('Feishu API error 10010');
    });

    it('should throw when no block_id in response', async () => {
      nock(FEISHU_API)
        .post('/open-apis/docx/v1/documents/doc123/blocks/doc123/children')
        .reply(200, { code: 0, msg: 'ok', data: { children: [] } });

      await expect(createImageBlock('test-token', 'doc123', 0))
        .rejects.toThrow('No block_id returned');
    });
  });

  describe('uploadDocxImage', () => {
    let tempDir: string;
    let tempImage: string;

    beforeEach(async () => {
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'upload-test-'));
      tempImage = path.join(tempDir, 'chart.png');
      await fs.promises.writeFile(tempImage, Buffer.from('fake-png-data'));
    });

    afterEach(async () => {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it('should upload image and return file_token', async () => {
      nock(FEISHU_API)
        .post('/open-apis/drive/v1/medias/upload_all')
        .reply(200, {
          code: 0,
          msg: 'ok',
          data: { file_token: 'ft-abc-123' },
        });

      const fileToken = await uploadDocxImage('test-token', tempImage);
      expect(fileToken).toBe('ft-abc-123');
    });

    it('should reject unsupported image formats', async () => {
      const tiffFile = path.join(tempDir, 'image.tiff');
      await fs.promises.writeFile(tiffFile, Buffer.from('tiff-data'));

      // .tiff is actually in the supported list, let's use .txt instead
      const txtFile = path.join(tempDir, 'image.txt');
      await fs.promises.writeFile(txtFile, Buffer.from('text-data'));

      await expect(uploadDocxImage('test-token', txtFile))
        .rejects.toThrow('Unsupported image format');
    });

    it('should throw when file does not exist', async () => {
      await expect(uploadDocxImage('test-token', '/nonexistent/file.png'))
        .rejects.toThrow();
    });

    it('should throw when API returns error', async () => {
      nock(FEISHU_API)
        .post('/open-apis/drive/v1/medias/upload_all')
        .reply(200, { code: 10012, msg: 'upload failed' });

      await expect(uploadDocxImage('test-token', tempImage))
        .rejects.toThrow('Feishu upload error 10012');
    });
  });

  describe('replaceImageBlock', () => {
    it('should replace image block with uploaded file', async () => {
      nock(FEISHU_API)
        .patch('/open-apis/docx/v1/documents/doc123/blocks/blk_456', (body) => {
          expect(body.replace_image).toBeDefined();
          expect(body.replace_image.token).toBe('ft-abc-123');
          return true;
        })
        .reply(200, {
          code: 0,
          msg: 'ok',
          data: {
            block: { block_id: 'blk_456', block_type: 27 },
          },
        });

      const result = await replaceImageBlock('test-token', 'doc123', 'blk_456', 'ft-abc-123');
      expect(result).toBe('blk_456');
    });

    it('should throw when API returns error', async () => {
      nock(FEISHU_API)
        .patch('/open-apis/docx/v1/documents/doc123/blocks/blk_456')
        .reply(200, { code: 10013, msg: 'replace image failed' });

      await expect(replaceImageBlock('test-token', 'doc123', 'blk_456', 'ft-abc'))
        .rejects.toThrow('Feishu replace_image error 10013');
    });

    it('should throw on HTTP error', async () => {
      nock(FEISHU_API)
        .patch('/open-apis/docx/v1/documents/doc123/blocks/blk_456')
        .reply(403, { msg: 'forbidden' });

      await expect(replaceImageBlock('test-token', 'doc123', 'blk_456', 'ft-abc'))
        .rejects.toThrow('Failed to replace image block');
    });
  });

  describe('clearTokenCache', () => {
    it('should clear cached token so next call fetches new one', async () => {
      // First call
      nock(FEISHU_API)
        .post('/open-apis/auth/v3/tenant_access_token/internal')
        .reply(200, {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'token-1',
          expire: 7200,
        });

      const token1 = await getTenantAccessToken('app-id', 'app-secret');
      expect(token1).toBe('token-1');

      // Clear cache
      clearTokenCache();

      // Second call should fetch new token
      nock(FEISHU_API)
        .post('/open-apis/auth/v3/tenant_access_token/internal')
        .reply(200, {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'token-2',
          expire: 7200,
        });

      const token2 = await getTenantAccessToken('app-id', 'app-secret');
      expect(token2).toBe('token-2');
    });
  });
});
