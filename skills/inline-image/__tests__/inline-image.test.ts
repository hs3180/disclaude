/**
 * Tests for inline-image skill.
 *
 * - Validation logic tested directly (no network needed)
 * - Lark API functions tested by mocking globalThis.fetch (reliable in all test runners)
 * - Integration tests run the script as a child process in dry-run mode
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  validateDocId,
  validateImagePath,
  validateIndex,
  validateCredentials,
  getTenantAccessToken,
  createImageBlock,
  uploadImage,
  replaceImageBlock,
  BLOCK_CHILDREN_ENDPOINT,
} from '../inline-image.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SCRIPT_PATH = resolve(PROJECT_ROOT, 'skills/inline-image/inline-image.ts');
const TMP_DIR = resolve(PROJECT_ROOT, 'workspace/test-inline-image');

const DOC_ID = 'testdoc123456';

// Minimal valid PNG buffer (1x1 transparent PNG)
const PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c62000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

// ---- Mock fetch helper ----

function mockFetch(response: { ok: boolean; status: number; json: unknown }): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    text: () => Promise.resolve(JSON.stringify(response.json)),
    json: () => Promise.resolve(response.json),
  }));
}

function mockFetchSequence(responses: Array<{ ok: boolean; status: number; json: unknown }>): void {
  const mocks = responses.map((r) =>
    vi.fn().mockResolvedValue({
      ok: r.ok,
      status: r.status,
      text: () => Promise.resolve(JSON.stringify(r.json)),
      json: () => Promise.resolve(r.json),
    }),
  );
  let callIndex = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
    const mock = mocks[callIndex++];
    if (!mock) throw new Error(`Unexpected fetch call #${callIndex}`);
    return mock();
  }));
}

// ---- Helpers for integration tests (child process) ----

const BASE_ENV = {
  FEISHU_APP_ID: 'test_app_id',
  FEISHU_APP_SECRET: 'test_app_secret',
  DOC_ID,
  IMAGE_PATH: resolve(TMP_DIR, 'test-image.png'),
  INSERT_INDEX: '0',
};

async function runScript(
  envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('npx', ['tsx', SCRIPT_PATH], {
      env: { ...process.env, ...BASE_ENV, ...envOverrides },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      code: execErr.code ?? 1,
    };
  }
}

// ---- Test suites ----

describe('inline-image: validation', () => {
  it('validateDocId should throw for empty string', () => {
    expect(() => validateDocId('')).toThrow('DOC_ID');
  });

  it('validateDocId should throw for invalid characters', () => {
    expect(() => validateDocId('doc!@#')).toThrow('Invalid DOC_ID');
  });

  it('validateDocId should accept alphanumeric ID', () => {
    expect(() => validateDocId('abc123XYZ')).not.toThrow();
  });

  it('validateImagePath should throw for empty string', () => {
    expect(() => validateImagePath('')).toThrow('IMAGE_PATH');
  });

  it('validateImagePath should throw for unsupported extension', () => {
    expect(() => validateImagePath('/tmp/test.gif')).toThrow('extension');
  });

  it('validateImagePath should accept .png', () => {
    expect(() => validateImagePath('/tmp/test.png')).not.toThrow();
  });

  it('validateImagePath should accept .jpg', () => {
    expect(() => validateImagePath('/tmp/test.jpg')).not.toThrow();
  });

  it('validateImagePath should accept .jpeg', () => {
    expect(() => validateImagePath('/tmp/test.jpeg')).not.toThrow();
  });

  it('validateIndex should throw for empty string', () => {
    expect(() => validateIndex('')).toThrow('INSERT_INDEX');
  });

  it('validateIndex should throw for non-number', () => {
    expect(() => validateIndex('abc')).toThrow('Invalid INSERT_INDEX');
  });

  it('validateIndex should throw for value < -1', () => {
    expect(() => validateIndex('-5')).toThrow('>= -1');
  });

  it('validateIndex should return 0 for "0"', () => {
    expect(validateIndex('0')).toBe(0);
  });

  it('validateIndex should return -1 for "-1"', () => {
    expect(validateIndex('-1')).toBe(-1);
  });

  it('validateIndex should return 5 for "5"', () => {
    expect(validateIndex('5')).toBe(5);
  });

  it('validateCredentials should throw for empty appId', () => {
    expect(() => validateCredentials('', 'secret')).toThrow('FEISHU_APP_ID');
  });

  it('validateCredentials should throw for empty appSecret', () => {
    expect(() => validateCredentials('id', '')).toThrow('FEISHU_APP_SECRET');
  });

  it('validateCredentials should pass with valid inputs', () => {
    expect(() => validateCredentials('id', 'secret')).not.toThrow();
  });
});

describe('inline-image: getTenantAccessToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return token on successful auth', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { code: 0, msg: 'ok', tenant_access_token: 'test_token_xxx', expire: 7200 },
    });

    const token = await getTenantAccessToken('app_id', 'app_secret');
    expect(token).toBe('test_token_xxx');
  });

  it('should throw on API error code', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { code: 10014, msg: 'invalid app_id or app_secret' },
    });

    await expect(getTenantAccessToken('bad_id', 'bad_secret'))
      .rejects.toThrow('Auth API error: code=10014');
  });

  it('should throw on HTTP error', async () => {
    mockFetch({
      ok: false,
      status: 500,
      json: { error: 'Internal Server Error' },
    });

    await expect(getTenantAccessToken('id', 'secret'))
      .rejects.toThrow('Auth API HTTP error: 500');
  });
});

describe('inline-image: createImageBlock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return block_id on success', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { code: 0, msg: 'ok', data: { children: [{ block_id: 'blk_img_001', block_type: 27 }] } },
    });

    const blockId = await createImageBlock('token', DOC_ID, 3);
    expect(blockId).toBe('blk_img_001');
  });

  it('should include index in request body when >= 0', async () => {
    let receivedBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options: { body: string }) => {
      receivedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ code: 0, msg: 'ok', data: { children: [{ block_id: 'blk_001' }] } }),
      };
    }));

    await createImageBlock('token', DOC_ID, 5);
    expect(receivedBody).not.toBeNull();
    expect(receivedBody!.index).toBe(5);
  });

  it('should NOT include index when -1 (append)', async () => {
    let receivedBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options: { body: string }) => {
      receivedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ code: 0, msg: 'ok', data: { children: [{ block_id: 'blk_001' }] } }),
      };
    }));

    await createImageBlock('token', DOC_ID, -1);
    expect(receivedBody).not.toBeNull();
    expect(receivedBody!.index).toBeUndefined();
  });

  it('should always set block_type to 27', async () => {
    let receivedBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options: { body: string }) => {
      receivedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ code: 0, msg: 'ok', data: { children: [{ block_id: 'blk_001' }] } }),
      };
    }));

    await createImageBlock('token', DOC_ID, 0);
    expect(receivedBody).not.toBeNull();
    const children = (receivedBody!.children as Array<Record<string, unknown>>);
    expect(children[0].block_type).toBe(27);
  });

  it('should throw on API error', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { code: 2320001, msg: 'invalid param' },
    });

    await expect(createImageBlock('token', DOC_ID, 0))
      .rejects.toThrow('Create block API error: code=2320001');
  });

  it('should throw when no block_id returned', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { code: 0, msg: 'ok', data: { children: [] } },
    });

    await expect(createImageBlock('token', DOC_ID, 0))
      .rejects.toThrow('no block_id');
  });

  it('should send request to correct endpoint', async () => {
    let receivedUrl: string | null = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      receivedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ code: 0, msg: 'ok', data: { children: [{ block_id: 'blk_001' }] } }),
      };
    }));

    await createImageBlock('token', DOC_ID, 0);
    expect(receivedUrl).toContain(BLOCK_CHILDREN_ENDPOINT(DOC_ID));
  });
});

describe('inline-image: uploadImage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return file_token on success', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { code: 0, msg: 'ok', data: { file_token: 'ft_abc123' } },
    });

    const fileToken = await uploadImage('token', DOC_ID, PNG_BUFFER, 'test.png');
    expect(fileToken).toBe('ft_abc123');
  });

  it('should throw on upload API error', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { code: 1061003, msg: 'file size exceeds limit' },
    });

    await expect(uploadImage('token', DOC_ID, PNG_BUFFER, 'test.png'))
      .rejects.toThrow('Upload API error: code=1061003');
  });

  it('should throw when no file_token returned', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { code: 0, msg: 'ok', data: {} },
    });

    await expect(uploadImage('token', DOC_ID, PNG_BUFFER, 'test.png'))
      .rejects.toThrow('no file_token');
  });

  it('should send multipart/form-data content-type', async () => {
    let receivedHeaders: Record<string, string> | null = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options: { headers: Record<string, string> }) => {
      receivedHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ code: 0, msg: 'ok', data: { file_token: 'ft_001' } }),
      };
    }));

    await uploadImage('token', DOC_ID, PNG_BUFFER, 'test.png');
    expect(receivedHeaders!['Content-Type']).toContain('multipart/form-data');
  });
});

describe('inline-image: replaceImageBlock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should succeed on valid response', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { code: 0, msg: 'ok' },
    });

    await expect(replaceImageBlock('token', DOC_ID, 'blk_001', 'ft_001'))
      .resolves.toBeUndefined();
  });

  it('should send replace_image with token in body', async () => {
    let receivedBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options: { body: string }) => {
      receivedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ code: 0, msg: 'ok' }),
      };
    }));

    await replaceImageBlock('token', DOC_ID, 'blk_001', 'ft_xyz');
    expect(receivedBody).not.toBeNull();
    expect((receivedBody as Record<string, unknown>).replace_image).toEqual({ token: 'ft_xyz' });
  });

  it('should throw on API error', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { code: 2320015, msg: 'block not found' },
    });

    await expect(replaceImageBlock('token', DOC_ID, 'blk_001', 'ft_001'))
      .rejects.toThrow('Replace image API error: code=2320015');
  });
});

describe('inline-image: full 3-step process', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should complete all 3 steps successfully', async () => {
    mockFetchSequence([
      // Auth
      { ok: true, status: 200, json: { code: 0, msg: 'ok', tenant_access_token: 'tok_full', expire: 7200 } },
      // Step 1: create block
      { ok: true, status: 200, json: { code: 0, msg: 'ok', data: { children: [{ block_id: 'blk_full_001', block_type: 27 }] } } },
      // Step 2: upload
      { ok: true, status: 200, json: { code: 0, msg: 'ok', data: { file_token: 'ft_full_001' } } },
      // Step 3: replace
      { ok: true, status: 200, json: { code: 0, msg: 'ok' } },
    ]);

    const token = await getTenantAccessToken('app_id', 'app_secret');
    const blockId = await createImageBlock(token, DOC_ID, 2);
    const fileToken = await uploadImage(token, DOC_ID, PNG_BUFFER, 'chart.png');
    await replaceImageBlock(token, DOC_ID, blockId, fileToken);

    expect(token).toBe('tok_full');
    expect(blockId).toBe('blk_full_001');
    expect(fileToken).toBe('ft_full_001');
  });
});

describe('inline-image: integration (child process)', () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true });
    await writeFile(resolve(TMP_DIR, 'test-image.png'), PNG_BUFFER);
    await writeFile(resolve(TMP_DIR, 'test-image.jpg'), PNG_BUFFER);
    await writeFile(resolve(TMP_DIR, 'test-image.jpeg'), PNG_BUFFER);
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it('should fail when DOC_ID is missing', async () => {
    const result = await runScript({ DOC_ID: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DOC_ID');
  });

  it('should fail when image file does not exist', async () => {
    const result = await runScript({ IMAGE_PATH: '/nonexistent/image.png' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('should succeed in dry-run mode', async () => {
    const result = await runScript({ INLINE_IMAGE_SKIP_API: '1' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('dry-run');
    expect(result.stdout).toContain(DOC_ID);
    expect(result.stdout).toContain('test-image.png');
  });

  it('should report append position when INSERT_INDEX is -1', async () => {
    const result = await runScript({ INSERT_INDEX: '-1', INLINE_IMAGE_SKIP_API: '1' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('end (append)');
  });

  it('should report specific index when INSERT_INDEX is set', async () => {
    const result = await runScript({ INSERT_INDEX: '5', INLINE_IMAGE_SKIP_API: '1' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('index 5');
  });

  it('should accept JPG files in dry-run', async () => {
    const result = await runScript({
      IMAGE_PATH: resolve(TMP_DIR, 'test-image.jpg'),
      INLINE_IMAGE_SKIP_API: '1',
    });
    expect(result.code).toBe(0);
  });

  it('should accept JPEG files in dry-run', async () => {
    const result = await runScript({
      IMAGE_PATH: resolve(TMP_DIR, 'test-image.jpeg'),
      INLINE_IMAGE_SKIP_API: '1',
    });
    expect(result.code).toBe(0);
  });

  it('should fail when FEISHU_APP_ID is missing', async () => {
    const result = await runScript({ FEISHU_APP_ID: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FEISHU_APP_ID');
  });

  it('should fail when FEISHU_APP_SECRET is missing', async () => {
    const result = await runScript({ FEISHU_APP_SECRET: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FEISHU_APP_SECRET');
  });

  it('should fail for unsupported image extension', async () => {
    await writeFile(resolve(TMP_DIR, 'test.gif'), PNG_BUFFER);
    const result = await runScript({ IMAGE_PATH: resolve(TMP_DIR, 'test.gif') });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('extension');
  });
});
