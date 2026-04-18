/**
 * Screenshot capture via macOS `screencapture` CLI.
 *
 * Captures the full screen or a specified region, returning a PNG buffer
 * or writing to a file path.
 *
 * Issue #2216: Screenshot capture for visual analysis.
 *
 * @module mac-control/screenshot
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScreenshotOptions, ScreenshotResult, Rect } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Capture a screenshot using the macOS `screencapture` command.
 *
 * @param options - Capture options (region, cursor, filePath)
 * @returns Screenshot result with PNG buffer or file path
 *
 * @example
 * ```ts
 * // Full screenshot
 * const result = await captureScreenshot();
 * // result.buffer contains PNG data
 *
 * // Region screenshot
 * const result = await captureScreenshot({
 *   region: { x: 100, y: 200, width: 500, height: 300 }
 * });
 * ```
 */
export async function captureScreenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
  const outputPath = options?.filePath ?? join(tmpdir(), `mac-control-${randomUUID()}.png`);

  const args: string[] = ['-x', outputPath]; // -x = no sound

  // Region capture: screencapture -R x,y,width,height
  if (options?.region) {
    const { x, y, width, height } = options.region;
    args.unshift('-R', `${x},${y},${width},${height}`);
  }

  // Include cursor
  if (options?.cursor) {
    args.unshift('-C');
  }

  try {
    await execFileAsync('screencapture', args, { timeout: 10000 });

    if (options?.filePath) {
      return { success: true, filePath: outputPath };
    }

    // Read the file into buffer and clean up temp file
    const buffer = await readFile(outputPath);

    // Clean up temp file
    await unlink(outputPath).catch(() => { /* ignore cleanup errors */ });

    return { success: true, buffer };
  } catch (error) {
    // Clean up on failure
    if (!options?.filePath) {
      await unlink(outputPath).catch(() => { /* ignore */ });
    }

    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Screenshot failed: ${message}` };
  }
}

/**
 * Parse a Rect from a screencapture -R argument string.
 * Useful for validation.
 */
export function parseRectArg(rectStr: string): Rect | null {
  const parts = rectStr.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    return null;
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}
