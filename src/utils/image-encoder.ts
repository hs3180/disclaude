/**
 * Image Encoder - Convert image files to base64 for multimodal AI input.
 *
 * This module provides utilities for encoding image files into base64 format
 * that can be passed to AI models supporting vision capabilities.
 *
 * Issue #656: 增强多模态图片支持
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('ImageEncoder');

/**
 * Supported image formats for multimodal input.
 */
export const SUPPORTED_IMAGE_FORMATS = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
] as const;

export type SupportedImageFormat = typeof SUPPORTED_IMAGE_FORMATS[number];

/**
 * Result of image encoding.
 */
export interface EncodedImage {
  /** Base64 encoded image data (without data URI prefix) */
  data: string;
  /** MIME type of the image */
  mimeType: SupportedImageFormat;
  /** Original file size in bytes */
  originalSize: number;
  /** Base64 data size in bytes */
  encodedSize: number;
}

/**
 * Image encoding options.
 */
export interface ImageEncodingOptions {
  /** Maximum file size in bytes (default: 10MB) */
  maxSizeBytes?: number;
  /** Whether to log encoding details */
  verbose?: boolean;
}

/**
 * Default maximum image size (10MB).
 */
export const DEFAULT_MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Map file extension to MIME type.
 */
function getMimeTypeFromExtension(filePath: string): SupportedImageFormat | null {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, SupportedImageFormat> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return mimeMap[ext] || null;
}

/**
 * Check if a MIME type is supported for multimodal input.
 */
export function isSupportedImageFormat(mimeType: string | undefined): mimeType is SupportedImageFormat {
  if (!mimeType) {
    return false;
  }
  return SUPPORTED_IMAGE_FORMATS.includes(mimeType as SupportedImageFormat);
}

/**
 * Check if a file is likely an image based on extension or MIME type.
 */
export function isImageFile(filePath: string, mimeType?: string): boolean {
  // Check MIME type first
  if (mimeType && isSupportedImageFormat(mimeType)) {
    return true;
  }
  // Fall back to extension check
  const detectedMimeType = getMimeTypeFromExtension(filePath);
  return detectedMimeType !== null;
}

/**
 * Encode an image file to base64.
 *
 * Reads the image file from disk and converts it to base64 format
 * suitable for multimodal AI model input.
 *
 * @param filePath - Local path to the image file
 * @param options - Encoding options
 * @returns Encoded image data with metadata
 * @throws Error if file doesn't exist, is too large, or format is unsupported
 */
export async function encodeImageToBase64(
  filePath: string,
  options: ImageEncodingOptions = {}
): Promise<EncodedImage> {
  const {
    maxSizeBytes = DEFAULT_MAX_IMAGE_SIZE,
    verbose = false,
  } = options;

  // Check if file exists
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  // Check file size
  if (stats.size > maxSizeBytes) {
    throw new Error(
      `Image file too large: ${stats.size} bytes (max: ${maxSizeBytes} bytes)`
    );
  }

  // Detect MIME type from extension (we don't trust the provided MIME type)
  const mimeType = getMimeTypeFromExtension(filePath);
  if (!mimeType) {
    throw new Error(
      `Unsupported image format: ${path.extname(filePath)}. ` +
      `Supported formats: ${SUPPORTED_IMAGE_FORMATS.join(', ')}`
    );
  }

  // Read and encode file
  const buffer = await fs.readFile(filePath);
  const base64Data = buffer.toString('base64');

  if (verbose) {
    logger.info({
      filePath,
      mimeType,
      originalSize: stats.size,
      encodedSize: base64Data.length,
    }, 'Image encoded successfully');
  }

  return {
    data: base64Data,
    mimeType,
    originalSize: stats.size,
    encodedSize: base64Data.length,
  };
}

/**
 * Encode multiple image files to base64.
 *
 * Processes an array of file paths and returns encoded images.
 * Skips files that are not images or fail to encode.
 *
 * @param filePaths - Array of local file paths
 * @param options - Encoding options
 * @returns Array of successfully encoded images
 */
export async function encodeImages(
  filePaths: string[],
  options: ImageEncodingOptions = {}
): Promise<EncodedImage[]> {
  const results: EncodedImage[] = [];

  for (const filePath of filePaths) {
    try {
      const encoded = await encodeImageToBase64(filePath, options);
      results.push(encoded);
    } catch (error) {
      logger.warn({ err: error, filePath }, 'Failed to encode image, skipping');
    }
  }

  return results;
}
