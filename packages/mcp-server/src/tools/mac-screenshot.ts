/**
 * macOS screenshot tool implementation.
 *
 * Provides AI Agent with macOS screen capture and coordinate calibration
 * capabilities via the built-in `screencapture` command and
 * `system_profiler` for display info.
 *
 * Issue #2216: Phase 1 (Part 1/3) — Screen capture only.
 * Mouse/keyboard input and window management will follow in separate PRs.
 *
 * **Platform Note**: All tools only work on macOS. On other platforms,
 * tools return an error indicating unsupported platform.
 *
 * **Security Note**: macOS may require the calling process to be granted
 * Screen Recording permission in System Settings → Privacy & Security.
 *
 * @module mcp-server/tools/mac-screenshot
 */

import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@disclaude/core';

const logger = createLogger('MacScreenshot');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/**
 * Returns true if running on macOS.
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * Returns a platform-not-supported result object.
 */
function platformError<T extends { success: false; error: string; message: string }>(
  factory: (error: string) => T,
): T {
  return factory(`macOS screen control is only available on macOS. Current platform: ${process.platform}`);
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ScreenshotResult {
  success: boolean;
  message: string;
  /** Absolute path to the saved screenshot PNG file */
  filePath?: string;
  error?: string;
}

export interface CalibrateResult {
  success: boolean;
  message: string;
  /** Retina = 2.0, Standard = 1.0 */
  scaleFactor?: number;
  /** Physical screen width in pixels */
  screenWidth?: number;
  /** Physical screen height in pixels */
  screenHeight?: number;
  /** Logical screen width in points */
  logicalWidth?: number;
  /** Logical screen height in points */
  logicalHeight?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run an AppleScript snippet via `osascript -e`.
 */
function runAppleScript(script: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('osascript', ['-e', script], { timeout: 10_000 });
}

/**
 * Generate a temporary screenshot file path.
 */
function screenshotTempPath(): string {
  const id = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `disclaude-screenshot-${id}.png`);
}

// ---------------------------------------------------------------------------
// Tool: mac_screenshot
// ---------------------------------------------------------------------------

/**
 * Take a screenshot on macOS using the built-in `screencapture` command.
 *
 * @param options.region - Optional crop region `{x, y, width, height}` (logical points).
 * @param options.cursor - Whether to show the cursor in the screenshot (default: false).
 * @param options.windowId - Optional window ID to capture a specific window.
 */
export async function mac_screenshot(options?: {
  region?: { x: number; y: number; width: number; height: number };
  cursor?: boolean;
  windowId?: number;
}): Promise<ScreenshotResult> {
  if (!isMacOS()) {
    return platformError((error) => ({ success: false, message: `❌ ${error}`, error }));
  }

  const filePath = screenshotTempPath();

  try {
    const args: string[] = ['-x']; // -x = no sound

    if (!options?.cursor) {
      args.push('-C'); // -C = do not capture cursor
    }

    if (options?.region) {
      const { x, y, width, height } = options.region;
      args.push('-R', `${x},${y},${width},${height}`);
    }

    if (options?.windowId) {
      args.push('-l', String(options.windowId));
    }

    args.push(filePath);

    logger.debug({ filePath, args }, 'Taking screenshot');
    await execFileAsync('screencapture', args, { timeout: 15_000 });

    // Verify the file was created
    const buffer = await readFile(filePath);
    logger.debug({ filePath, size: buffer.length }, 'Screenshot saved');

    return {
      success: true,
      message: `✅ Screenshot saved to ${filePath} (${(buffer.length / 1024).toFixed(0)} KB)`,
      filePath,
    };
  } catch (error) {
    // Clean up failed screenshot file
    try { await unlink(filePath); } catch { /* ignore */ }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'Screenshot failed');
    return {
      success: false,
      message: `❌ Screenshot failed: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: mac_calibrate
// ---------------------------------------------------------------------------

/**
 * Calibrate screen coordinates for Retina displays on macOS.
 *
 * Detects the screen's backing scale factor and reports both logical
 * and physical dimensions. Use this to convert between screenshot
 * pixel coordinates and logical point coordinates.
 *
 * Formula: `logical_coordinate = pixel_coordinate / scaleFactor`
 */
export async function mac_calibrate(): Promise<CalibrateResult> {
  if (!isMacOS()) {
    return platformError((error) => ({ success: false, message: `❌ ${error}`, error }));
  }

  try {
    // Get screen dimensions using system_profiler
    const { stdout: displayInfo } = await execFileAsync(
      'system_profiler',
      ['SPDisplaysDataType'],
      { timeout: 10_000 },
    );

    // Parse resolution from output (e.g., "Resolution: 2560 x 1600 Retina")
    const resolutionMatch = displayInfo.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
    const retinaMatch = displayInfo.match(/Retina/);

    // Get logical screen size via AppleScript
    const { stdout: logicalSize } = await runAppleScript(`
tell application "Finder"
  set screenBounds to bounds of window of desktop
  return (item 3 of screenBounds) & "," & (item 4 of screenBounds)
end tell`);

    const [logicalW, logicalH] = logicalSize.trim().split(',').map(Number);

    let physicalW = 0;
    let physicalH = 0;
    if (resolutionMatch) {
      physicalW = parseInt(resolutionMatch[1], 10);
      physicalH = parseInt(resolutionMatch[2], 10);
    }

    // Calculate scale factor
    // On Retina: logical = physical / 2 (typically)
    // On non-Retina: logical ≈ physical (scaleFactor ≈ 1)
    let scaleFactor = 1;
    if (retinaMatch && logicalW > 0 && physicalW > 0) {
      scaleFactor = physicalW / logicalW;
    }

    const isRetina = !!retinaMatch;

    logger.debug({
      scaleFactor,
      physicalW,
      physicalH,
      logicalW,
      logicalH,
      isRetina,
    }, 'Calibration complete');

    return {
      success: true,
      message: `✅ Screen calibrated: ${isRetina ? 'Retina' : 'Standard'} display, scale factor=${scaleFactor}x, logical=${logicalW}x${logicalH}, physical=${physicalW}x${physicalH}`,
      scaleFactor,
      screenWidth: physicalW,
      screenHeight: physicalH,
      logicalWidth: logicalW,
      logicalHeight: logicalH,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'Calibration failed');
    return {
      success: false,
      message: `❌ Calibration failed: ${errorMessage}`,
      error: errorMessage,
    };
  }
}
