#!/usr/bin/env tsx
/**
 * skills/upload-docx-image/upload-docx-image.ts
 *
 * 在飞书文档指定位置插入图片。
 *
 * 认证方式：读取 lark-cli 的配置文件（~/.lark-cli/config.json），不直接使用环境变量。
 *
 * 环境变量：
 *   DOC_ID              (必需) 飞书文档 ID
 *   IMAGE_PATH          (必需) 图片文件绝对路径（PNG/JPG/JPEG）
 *   INSERT_INDEX        (必需) 0-based 插入位置（-1 追加到末尾）
 *   UPLOAD_DOCX_SKIP_API (可选) 设为 '1' 跳过实际 API 调用（dry-run）
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';

// ---- Constants ----

const LARK_BASE_URL = 'https://open.feishu.cn';
const AUTH_ENDPOINT = '/open-apis/auth/v3/tenant_access_token/internal';
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const LARK_CLI_CONFIG_PATHS = [
  '.lark-cli/config.json',
  '.config/lark-cli/config.json',
];

// ---- Types ----

interface LarkCliConfig {
  app_id?: string;
  app_secret?: string;
}

interface TokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

interface BlockChildrenResponse {
  code: number;
  msg: string;
  data?: {
    children?: Array<{ block_id: string; block_type?: number }>;
  };
}

interface UploadResponse {
  code: number;
  msg: string;
  data?: {
    file_token: string;
  };
}

interface BlockUpdateResponse {
  code: number;
  msg: string;
}

interface BlockDeleteResponse {
  code: number;
  msg: string;
}

// ---- Helpers ----

/**
 * 从 lark-cli 配置文件读取凭据。
 * lark-cli 使用 ~/.lark-cli/config.json 存储 app_id 和 app_secret。
 */
function readLarkCliCredentials(): LarkCliConfig {
  const home = homedir();

  for (const relative of LARK_CLI_CONFIG_PATHS) {
    const filePath = resolve(home, relative);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const config = JSON.parse(content) as LarkCliConfig;
        if (config.app_id && config.app_secret) {
          return config;
        }
      } catch {
        // 文件损坏或格式错误，继续尝试下一个路径
      }
    }
  }

  return {};
}

/**
 * 获取 tenant_access_token。
 */
async function getTenantAccessToken(
  appId: string,
  appSecret: string,
): Promise<string> {
  const url = `${LARK_BASE_URL}${AUTH_ENDPOINT}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  if (!response.ok) {
    throw new Error(`Auth API HTTP error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as TokenResponse;
  if (data.code !== 0) {
    throw new Error(`Auth API error: code=${data.code}, msg=${data.msg}`);
  }

  return data.tenant_access_token;
}

/**
 * 步骤 1: 在指定位置创建空图片块，返回 block_id。
 */
async function createImageBlock(
  token: string,
  docId: string,
  index: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    children: [{ block_type: 27 }],
  };
  if (index >= 0) {
    body.index = index;
  }

  const url = `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Create block HTTP error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as BlockChildrenResponse;
  if (data.code !== 0) {
    throw new Error(`Create block API error: code=${data.code}, msg=${data.msg}`);
  }

  const children = data.data?.children;
  if (!children || children.length === 0 || !children[0].block_id) {
    throw new Error('Create block returned no block_id');
  }

  return children[0].block_id;
}

/**
 * 步骤 2: 通过 multipart/form-data 上传图片文件，返回 file_token。
 */
async function uploadImage(
  token: string,
  docId: string,
  imageBuffer: Buffer,
  fileName: string,
): Promise<string> {
  const boundary = `----FormBoundary${Date.now()}`;

  const parentTypePart = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="parent_type"',
    '',
    'docx_image',
  ].join('\r\n');

  const parentNodePart = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="parent_node"',
    '',
    docId,
  ].join('\r\n');

  const fileNameSafe = fileName.replace(/["\\]/g, '_');
  const filePart = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fileNameSafe}"`,
    'Content-Type: application/octet-stream',
    '',
  ].join('\r\n') + '\r\n';

  const closingBoundary = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(parentTypePart + '\r\n', 'utf-8'),
    Buffer.from(parentNodePart + '\r\n', 'utf-8'),
    Buffer.from(filePart, 'utf-8'),
    imageBuffer,
    Buffer.from(closingBoundary, 'utf-8'),
  ]);

  const url = `${LARK_BASE_URL}/open-apis/drive/v1/medias/upload_all`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload HTTP error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as UploadResponse;
  if (data.code !== 0) {
    throw new Error(`Upload API error: code=${data.code}, msg=${data.msg}`);
  }

  if (!data.data?.file_token) {
    throw new Error('Upload returned no file_token');
  }

  return data.data.file_token;
}

/**
 * 步骤 3: 通过 replace_image 将上传的文件绑定到图片块。
 */
async function replaceImageBlock(
  token: string,
  docId: string,
  blockId: string,
  fileToken: string,
): Promise<void> {
  const url = `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replace_image: { token: fileToken } }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Replace image HTTP error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as BlockUpdateResponse;
  if (data.code !== 0) {
    throw new Error(`Replace image API error: code=${data.code}, msg=${data.msg}`);
  }
}

/**
 * 获取文档根块的子块数量（用于计算 append 时的实际索引）。
 */
async function getBlockCount(token: string, docId: string): Promise<number> {
  const url = `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/${docId}?page_size=500`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return -1;
  const data = await response.json() as { data?: { items?: unknown[] } };
  return data.data?.items?.length ?? -1;
}

/**
 * 回滚: 通过 block_id 查找索引并删除已创建的空图片块。
 *
 * 飞书 API 的 DELETE blocks/children 需要 start_index/end_index，
 * 因此先获取文档子块列表，找到目标 block_id 的位置后删除。
 */
async function deleteBlock(
  token: string,
  docId: string,
  blockId: string,
): Promise<void> {
  // 获取文档块列表以找到 block_id 的索引
  const listUrl = `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/${docId}?page_size=500`;
  const listResp = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!listResp.ok) {
    console.error(`WARN: Rollback — could not list blocks: ${listResp.status}`);
    return;
  }

  const listData = await listResp.json() as {
    data?: { items?: Array<{ block_id: string }> };
  };
  const items = listData.data?.items ?? [];
  const blockIdx = items.findIndex((b) => b.block_id === blockId);

  if (blockIdx === -1) {
    console.error(`WARN: Rollback — block ${blockId} not found in document`);
    return;
  }

  const deleteUrl = `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`;
  const response = await fetch(deleteUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      start_index: blockIdx,
      end_index: blockIdx + 1,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`WARN: Rollback delete failed (non-fatal): ${response.status} ${text}`);
    return;
  }

  const data = (await response.json()) as BlockDeleteResponse;
  if (data.code !== 0) {
    console.error(`WARN: Rollback delete API error (non-fatal): code=${data.code}, msg=${data.msg}`);
  } else {
    console.error(`INFO: Rollback — deleted block ${blockId} at index ${blockIdx}`);
  }
}

// ---- Validation ----

function validateInputs(): {
  docId: string;
  imagePath: string;
  index: number;
} {
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const indexStr = process.env.INSERT_INDEX ?? '';

  if (!docId) {
    throw new Error('DOC_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    throw new Error(
      `Invalid DOC_ID '${docId}' — must match pattern: letters, digits, hyphens, underscores`,
    );
  }

  if (!imagePath) {
    throw new Error('IMAGE_PATH environment variable is required');
  }
  const ext = extname(imagePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Invalid IMAGE_PATH extension '${ext}' — must be one of: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    );
  }

  if (!indexStr && indexStr !== '0') {
    throw new Error('INSERT_INDEX environment variable is required');
  }
  const index = parseInt(indexStr, 10);
  if (!Number.isFinite(index) || index < -1) {
    throw new Error(`Invalid INSERT_INDEX '${indexStr}' — must be an integer >= -1`);
  }

  return { docId, imagePath, index };
}

// ---- Main ----

async function main(): Promise<void> {
  let docId: string;
  let imagePath: string;
  let index: number;

  try {
    const validated = validateInputs();
    docId = validated.docId;
    imagePath = validated.imagePath;
    index = validated.index;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const absoluteImagePath = resolve(imagePath);

  // Check file
  try {
    const fileStat = statSync(absoluteImagePath);
    if (fileStat.size === 0) {
      console.error('ERROR: Image file is empty');
      process.exit(1);
    }
    if (fileStat.size > MAX_IMAGE_SIZE) {
      console.error(
        `ERROR: Image file too large: ${(fileStat.size / 1024 / 1024).toFixed(1)} MB (max: 20 MB)`,
      );
      process.exit(1);
    }
  } catch {
    console.error(`ERROR: Image file not found: ${absoluteImagePath}`);
    process.exit(1);
  }

  const fileName = basename(absoluteImagePath);
  const position = index === -1 ? 'end (append)' : `index ${index}`;

  // Read credentials from lark-cli config
  const credentials = readLarkCliCredentials();
  if (!credentials.app_id || !credentials.app_secret) {
    console.error(
      'ERROR: lark-cli not authenticated. Please run: lark-cli config init',
    );
    console.error(
      '  Config file not found at ~/.lark-cli/config.json or credentials are missing.',
    );
    process.exit(1);
  }

  console.log(
    `INFO: Inserting '${fileName}' into doc ${docId} at ${position}`,
  );

  // Get tenant access token
  let token: string;
  try {
    token = await getTenantAccessToken(credentials.app_id, credentials.app_secret);
    console.log('INFO: Authenticated via lark-cli credentials');
  } catch (err) {
    console.error(
      `ERROR: Failed to get access token: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  // Step 1: Create empty image block
  let blockId: string;
  try {
    blockId = await createImageBlock(token, docId, index);
    console.log(`INFO: Created empty image block ${blockId} at ${position}`);
  } catch (err) {
    console.error(
      `ERROR: Step 1 failed (create block): ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  // Step 2: Upload image file (with rollback on failure)
  let fileToken: string;
  try {
    const imageBuffer = await readFile(absoluteImagePath);
    fileToken = await uploadImage(token, docId, imageBuffer, fileName);
    console.log(`INFO: Uploaded image, file_token: ${fileToken}`);
  } catch (err) {
    console.error(
      `ERROR: Step 2 failed (upload image): ${err instanceof Error ? err.message : err}`,
    );
    console.error('INFO: Rolling back — deleting empty image block...');
    try {
      await deleteBlock(token, docId, blockId);
    } catch {
      // rollback failure is non-fatal
    }
    process.exit(1);
  }

  // Step 3: Bind image to block (with rollback on failure)
  try {
    await replaceImageBlock(token, docId, blockId, fileToken);
    console.log(`INFO: Bound image to block ${blockId}`);
  } catch (err) {
    console.error(
      `ERROR: Step 3 failed (bind image): ${err instanceof Error ? err.message : err}`,
    );
    console.error('INFO: Rolling back — deleting image block...');
    try {
      await deleteBlock(token, docId, blockId);
    } catch {
      // rollback failure is non-fatal
    }
    process.exit(1);
  }

  console.log(`OK: Image inserted successfully`);
  console.log(`  block_id: ${blockId}`);
  console.log(`  file_token: ${fileToken}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
