/**
 * Feishu Document Image Insertion - 3-step API implementation.
 *
 * Issue #2278: Inserts an image into a Feishu document at a specific position.
 *
 * Process:
 * 1. Create empty image block (block_type: 27) at the specified index
 * 2. Upload image file via Drive Media Upload API
 * 3. Bind uploaded file to the image block via replace_image
 *
 * Reference:
 * - https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block-children/create
 * - https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all
 * - https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block/update
 * - https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/faq
 *
 * @module primary-node/platforms/feishu/insert-docx-image
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { createLogger, FEISHU_API } from '@disclaude/core';

const logger = createLogger('InsertDocxImage');

/** Feishu API base URL */
const FEISHU_BASE_URL = 'https://open.feishu.cn';

/** Image block type in Feishu docx API */
const BLOCK_TYPE_IMAGE = 27;

/**
 * Get tenant access token for Feishu API calls.
 */
async function getTenantAccessToken(
  appId: string,
  appSecret: string,
): Promise<string> {
  const resp = await axios.post(
    `${FEISHU_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      app_id: appId,
      app_secret: appSecret,
    },
    { timeout: FEISHU_API.REQUEST_TIMEOUT_MS },
  );

  const { tenant_access_token } = resp.data;
  if (!tenant_access_token) {
    throw new Error(`Failed to get tenant access token: ${JSON.stringify(resp.data)}`);
  }
  return tenant_access_token;
}

/**
 * Step 1: Create an empty image block at the specified index.
 *
 * POST /open-apis/docx/v1/documents/{document_id}/blocks/{document_id}/children
 */
async function createImageBlock(
  token: string,
  documentId: string,
  index: number,
): Promise<string> {
  const url = `${FEISHU_BASE_URL}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`;

  const body: Record<string, unknown> = {
    children: [
      {
        block_type: BLOCK_TYPE_IMAGE,
        // Empty image block — will be filled in step 3
      },
    ],
  };

  // Only set index if not -1 (append)
  if (index >= 0) {
    body.index = index;
  }

  const resp = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: FEISHU_API.REQUEST_TIMEOUT_MS,
  });

  const { data } = resp;
  if (data.code !== 0) {
    throw new Error(`createImageBlock failed: code=${data.code}, msg=${data.msg}`);
  }

  // Extract the new block ID from the response
  const children = data?.data?.children;
  if (!children || !Array.isArray(children) || children.length === 0) {
    throw new Error(`createImageBlock: no children returned in response: ${JSON.stringify(data)}`);
  }

  return children[0].block_id;
}

/**
 * Step 2: Upload image file via Drive Media Upload API.
 *
 * POST /open-apis/drive/v1/medias/upload_all
 * Content-Type: multipart/form-data
 */
async function uploadImage(
  token: string,
  documentId: string,
  imagePath: string,
): Promise<string> {
  const url = `${FEISHU_BASE_URL}/open-apis/drive/v1/medias/upload_all`;

  const fileBuffer = fs.readFileSync(imagePath);
  const fileName = path.basename(imagePath);

  // Determine the file extension for upload
  const ext = path.extname(imagePath).toLowerCase();
  const mimeTypeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
  };
  const mimeType = mimeTypeMap[ext] || 'application/octet-stream';

  // Build multipart form data manually
  const boundary = `----FormBoundary${Date.now()}`;
  const parts: Buffer[] = [];

  // Add form field: parent_type
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\ndocx_image\r\n`
  ));

  // Add form field: parent_node (document_id)
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n${documentId}\r\n`
  ));

  // Add form field: file
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const resp = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    timeout: 60 * 1000, // 60 seconds for upload
    maxContentLength: 30 * 1024 * 1024,
    maxBodyLength: 30 * 1024 * 1024,
  });

  const { data } = resp;
  if (data.code !== 0) {
    throw new Error(`uploadImage failed: code=${data.code}, msg=${data.msg}`);
  }

  return data.data.file_token;
}

/**
 * Step 3: Bind the uploaded image to the image block via replace_image.
 *
 * PATCH /open-apis/docx/v1/documents/{document_id}/blocks/{block_id}
 *
 * Uses the update_text_elements with replace_image operation.
 */
async function bindImage(
  token: string,
  documentId: string,
  blockId: string,
  fileToken: string,
  width?: number,
): Promise<void> {
  const url = `${FEISHU_BASE_URL}/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}`;

  const body: Record<string, unknown> = {
    update_text_elements: {
      elements: [
        {
          replace_image: {
            token: fileToken,
          },
        },
      ],
    },
  };

  // Add width if specified
  if (width && width > 0) {
    body.update_text_elements = {
      elements: [
        {
          replace_image: {
            token: fileToken,
            width,
          },
        },
      ],
    };
  }

  const resp = await axios.patch(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: FEISHU_API.REQUEST_TIMEOUT_MS,
  });

  const { data } = resp;
  if (data.code !== 0) {
    throw new Error(`bindImage failed: code=${data.code}, msg=${data.msg}`);
  }
}

/**
 * Insert an image into a Feishu document at a specific position.
 *
 * Performs the 3-step API process:
 * 1. Create empty image block at the specified index
 * 2. Upload the image file
 * 3. Bind the uploaded image to the block
 *
 * @param appId - Feishu App ID
 * @param appSecret - Feishu App Secret
 * @param params - Insert parameters
 * @returns Result with blockId and fileToken
 */
export async function insertDocxImageIntoDocument(
  appId: string,
  appSecret: string,
  params: {
    documentId: string;
    imagePath: string;
    index: number;
    width?: number;
  },
): Promise<{ success: boolean; blockId?: string; fileToken?: string }> {
  const { documentId, imagePath, index, width } = params;

  logger.info({ documentId, imagePath, index, width }, 'Starting docx image insertion');

  // Get tenant access token
  const token = await getTenantAccessToken(appId, appSecret);
  logger.debug('Obtained tenant access token');

  // Step 1: Create empty image block
  let blockId: string;
  try {
    blockId = await createImageBlock(token, documentId, index);
    logger.debug({ blockId }, 'Step 1: Created empty image block');
  } catch (error) {
    logger.error({ err: error, documentId, index }, 'Step 1 failed: createImageBlock');
    throw error;
  }

  // Step 2: Upload image file
  let fileToken: string;
  try {
    fileToken = await uploadImage(token, documentId, imagePath);
    logger.debug({ fileToken }, 'Step 2: Uploaded image file');
  } catch (error) {
    logger.error({ err: error, documentId, imagePath }, 'Step 2 failed: uploadImage');
    // Attempt cleanup: delete the empty image block we created
    try {
      await axios.delete(
        `${FEISHU_BASE_URL}/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: FEISHU_API.REQUEST_TIMEOUT_MS,
        },
      );
      logger.debug({ blockId }, 'Cleaned up empty image block after upload failure');
    } catch {
      logger.warn({ blockId }, 'Failed to clean up empty image block');
    }
    throw error;
  }

  // Step 3: Bind image to block
  try {
    await bindImage(token, documentId, blockId, fileToken, width);
    logger.debug({ blockId, fileToken }, 'Step 3: Bound image to block');
  } catch (error) {
    logger.error({ err: error, blockId, fileToken }, 'Step 3 failed: bindImage');
    throw error;
  }

  logger.info({ documentId, blockId, fileToken, index }, 'Image inserted successfully');
  return { success: true, blockId, fileToken };
}
