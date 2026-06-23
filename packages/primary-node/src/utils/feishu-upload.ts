/**
 * Shared Feishu file upload utilities.
 *
 * Deduplicates upload logic between feishu-channel.ts and feishu-adapter.ts.
 *
 * Issue #4132: Deduplicate Feishu file upload logic.
 */

import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';

/**
 * Image file extensions recognized by the Feishu image upload API
 * (im.image.create / im-v1/image/create).
 *
 * NOTE: `.svg` is intentionally excluded — Feishu rejects SVG on the image
 * API (400 "unsupported image format"; only png/jpg/jpeg/webp/gif/tiff/bmp/ico
 * are accepted). SVG therefore falls through to im.file.create as a `stream`
 * file, which uploads successfully.
 */
export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico',
]);

/**
 * Feishu file_type values accepted by the im.file.create API.
 */
export type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

/**
 * File extension to Feishu file_type mapping for document uploads.
 */
export const EXT_TO_FEISHU_FILE_TYPE: Record<string, FeishuFileType> = {
  '.opus': 'opus',
  '.pdf': 'pdf',
  '.doc': 'doc', '.docx': 'doc',
  '.xls': 'xls', '.xlsx': 'xls', '.csv': 'xls',
  '.ppt': 'ppt', '.pptx': 'ppt',
};

/** Maximum image file size in bytes (10 MB). */
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Maximum document file size in bytes (30 MB). */
export const MAX_FILE_SIZE = 30 * 1024 * 1024;

/**
 * Upload an image to Feishu and return the image_key.
 *
 * @param client - Lark SDK client
 * @param filePath - Local file path of the image
 * @returns image_key string, or undefined on failure
 */
export async function uploadImage(
  client: lark.Client,
  filePath: string,
): Promise<string | undefined> {
  const uploadResp = await client.im.image.create({
    data: {
      image_type: 'message',
      image: fs.createReadStream(filePath),
    },
  });
  return uploadResp?.image_key;
}

/**
 * Upload a file to Feishu and return the file_key.
 *
 * @param client - Lark SDK client
 * @param filePath - Local file path
 * @param fileName - Original file name for the upload
 * @param fileType - Feishu file_type (e.g. 'pdf', 'mp4', 'stream')
 * @returns file_key string, or undefined on failure
 */
export async function uploadFile(
  client: lark.Client,
  filePath: string,
  fileName: string,
  fileType: FeishuFileType,
): Promise<string | undefined> {
  const uploadResp = await client.im.file.create({
    data: {
      file_type: fileType,
      file_name: fileName,
      file: fs.createReadStream(filePath),
    },
  });
  return uploadResp?.file_key;
}
