/**
 * Video cover image extractor.
 *
 * Uses ffmpeg to extract the first frame of a video file as a JPEG cover image.
 * Required by Feishu's `msg_type: 'media'` for video messages — Feishu mandates
 * an `image_key` alongside the `file_key`.
 *
 * Issue #2265: Proper video support via msg_type:'media'.
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '@disclaude/core';

const logger = createLogger('VideoCoverExtractor');

/** Video file extensions that should use Feishu's media message type. */
export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv',
]);

/**
 * Result of a video cover extraction attempt.
 */
export interface VideoCoverResult {
  /** Whether extraction succeeded */
  success: boolean;
  /** Path to the extracted cover image JPEG (only when success=true) */
  coverPath?: string;
  /** Error message (only when success=false) */
  error?: string;
}

/**
 * Check whether ffmpeg is available on the system PATH.
 *
 * Cached after first check to avoid repeated subprocess spawns.
 */
let _ffmpegAvailable: boolean | undefined;

/** Reset cached ffmpeg availability (for testing). */
export function _resetFfmpegCache(): void {
  _ffmpegAvailable = undefined;
}

export function isFfmpegAvailable(): boolean {
  if (_ffmpegAvailable !== undefined) return _ffmpegAvailable;
  try {
    const result = child_process.spawnSync('ffmpeg', ['-version'], {
      timeout: 5000,
      stdio: 'pipe',
    });
    _ffmpegAvailable = result.status === 0;
  } catch {
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}

/**
 * Extract the first frame of a video file as a JPEG image.
 *
 * Uses `ffmpeg -i <input> -vframes 1 -f image2 <output>` to extract the frame.
 * The output JPEG is written to a temporary file.
 *
 * @param videoPath - Absolute path to the video file
 * @returns Result with cover image path on success, or error message on failure
 */
export function extractVideoCover(videoPath: string): VideoCoverResult {
  // Validate input
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { success: false, error: `Video file not found: ${videoPath}` };
  }

  if (!isFfmpegAvailable()) {
    return { success: false, error: 'ffmpeg is not installed or not found in PATH' };
  }

  // Create temp output path for cover image
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const coverPath = path.join(os.tmpdir(), `cover_${baseName}_${Date.now()}.jpg`);

  try {
    const result = child_process.spawnSync('ffmpeg', [
      '-i', videoPath,
      '-vframes', '1',
      '-f', 'image2',
      '-y',  // overwrite output
      coverPath,
    ], {
      timeout: 30000, // 30 second timeout for cover extraction
      stdio: 'pipe',
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString('utf-8') || 'unknown error';
      logger.warn({ videoPath, stderr: stderr.slice(-200) }, 'ffmpeg failed to extract cover frame');
      return { success: false, error: `ffmpeg exited with code ${result.status}: ${stderr.slice(-200)}` };
    }

    if (!fs.existsSync(coverPath) || fs.statSync(coverPath).size === 0) {
      return { success: false, error: 'ffmpeg produced no output file' };
    }

    logger.info({ videoPath, coverPath }, 'Video cover frame extracted');
    return { success: true, coverPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ videoPath, error: msg }, 'Failed to extract video cover');
    return { success: false, error: msg };
  }
}
