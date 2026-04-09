/**
 * Screen capture utility for macOS.
 *
 * Uses the built-in `screencapture` command to capture screenshots.
 * Supports full-screen and region capture with optional cursor inclusion.
 *
 * On Retina displays, `screencapture` produces images at 2x logical resolution.
 * Callers should use `CalibrationResult.scaleFactor` to convert between
 * screenshot pixel coordinates and logical (Cocoa/cliclick) coordinates.
 *
 * Issue #2216: Mac 屏幕控制能力 - 辅助功能自动化模块
 * Phase 1: 截图 + 图片读取
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { ScreenshotOptions, ScreenshotResult } from './types.js';

/**
 * Default timeout for screencapture command (ms).
 * screencapture can hang if screen recording permission is denied.
 */
const SCREENCAPTURE_TIMEOUT = 15_000;

/**
 * Capture a screenshot of the Mac screen.
 *
 * Uses `screencapture -x` (no sound, no UI) to capture the screen.
 * On Retina displays, the resulting image has dimensions of
 * `logicalWidth * scaleFactor × logicalHeight * scaleFactor`.
 *
 * @param options - Capture options (region, cursor, output path)
 * @returns ScreenshotResult with file path, dimensions, and raw buffer
 * @throws {MacControlError} If capture fails (no permission, not on macOS, etc.)
 *
 * @example
 * ```typescript
 * // Full screen capture
 * const result = await captureScreen();
 *
 * // Region capture (logical coordinates)
 * const region = await captureScreen({
 *   region: { x: 100, y: 100, width: 400, height: 300 }
 * });
 * ```
 */
export async function captureScreen(
  options: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const platform = process.platform;
  if (platform !== 'darwin') {
    throw new MacControlError(
      `Screen capture is only supported on macOS, current platform: ${platform}`,
    );
  }

  // Build output path
  const outputPath = options.outputPath ?? path.join(
    os.tmpdir(),
    `disclaude-screenshot-${Date.now()}.png`,
  );

  // Build screencapture arguments
  const args: string[] = ['-x']; // No sound, no UI overlay

  if (options.cursor) {
    args.push('-C'); // Include cursor
  }

  if (options.region) {
    // screencapture -R x,y,width,height (note: comma-separated, no spaces)
    args.push('-R', `${options.region.x},${options.region.y},${options.region.width},${options.region.height}`);
  }

  args.push(outputPath);

  // Execute screencapture
  await execWithTimeout('screencapture', args, SCREENCAPTURE_TIMEOUT);

  // Read the captured file
  const buffer = await fs.readFile(outputPath);

  // Parse PNG dimensions from the buffer
  const dimensions = parsePngDimensions(buffer);

  // Clean up temp file if we created it (not user-specified path)
  if (!options.outputPath) {
    await fs.unlink(outputPath).catch(() => {
      // Best effort cleanup
    });
  }

  return {
    filePath: outputPath,
    width: dimensions.width,
    height: dimensions.height,
    buffer,
  };
}

/**
 * Error thrown when a mac control operation fails.
 */
export class MacControlError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'MacControlError';
  }
}

/**
 * Execute a command with a timeout, throwing on failure or timeout.
 *
 * @internal — exposed for testing via dependency injection.
 */
export async function execWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      execFileAsync(command, args, { timeout: timeoutMs }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Command "${command}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);

    if (result.stderr && !result.stdout) {
      throw new MacControlError(`Command "${command}" failed: ${result.stderr.trim()}`);
    }

    return result.stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Provide actionable error messages for common issues
    if (message.includes('timed out')) {
      throw new MacControlError(
        `Screen capture timed out. This may indicate a permission issue.\n` +
        `Please check: System Settings → Privacy & Security → Screen Recording`,
        error instanceof Error ? error : undefined,
      );
    }

    if (message.includes('not allowed') || message.includes('screen recording')) {
      throw new MacControlError(
        `Screen recording permission denied.\n` +
        `Please grant permission: System Settings → Privacy & Security → Screen Recording`,
        error instanceof Error ? error : undefined,
      );
    }

    throw new MacControlError(
      `Screen capture failed: ${message}`,
      error instanceof Error ? error : undefined,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Parse PNG image dimensions from a PNG buffer.
 *
 * Reads the IHDR chunk to extract width and height.
 * PNG structure: 8-byte signature → 4-byte length → 4-byte "IHDR" → 4-byte width → 4-byte height.
 *
 * @param buffer - PNG file buffer
 * @returns Object with width and height in pixels
 * @throws {MacControlError} If buffer is not a valid PNG
 */
export function parsePngDimensions(buffer: Buffer): { width: number; height: number } {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length < 24 ||
      buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47) {
    throw new MacControlError('Invalid PNG buffer: signature mismatch');
  }

  // IHDR chunk starts at offset 8: length(4) + "IHDR"(4) + width(4) + height(4)
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  return { width, height };
}
