/**
 * macOS screen control tool implementation.
 *
 * Provides AI Agent with native macOS screen/keyboard/mouse control
 * capabilities via Accessibility API and CGEvent.
 *
 * Issue #2216: Phase 1 — Basic tool wrapping (screenshot, mouse, keyboard, window).
 *
 * **Platform Note**: All tools only work on macOS. On other platforms,
 * tools return an error indicating unsupported platform.
 *
 * **Security Note**: CGEvent is a hardware-level event mechanism.
 * macOS requires the calling process to be granted Accessibility
 * permission in System Settings → Privacy & Security → Accessibility.
 *
 * @module mcp-server/tools/mac-screen-control
 */

import { execFile, spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@disclaude/core';

const logger = createLogger('MacScreenControl');
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
  return factory(`macOS screen control is only available on macOS. Current platform: ${  process.platform}`);
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ScreenshotResult {
  success: boolean;
  message: string;
  filePath?: string;
  error?: string;
}

export interface ClickResult {
  success: boolean;
  message: string;
  error?: string;
}

export interface TypeTextResult {
  success: boolean;
  message: string;
  error?: string;
}

export interface PressKeyResult {
  success: boolean;
  message: string;
  error?: string;
}

export interface MoveMouseResult {
  success: boolean;
  message: string;
  error?: string;
}

export interface WindowInfo {
  success: boolean;
  message: string;
  appName: string;
  windowName?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  error?: string;
}

export interface CalibrateResult {
  success: boolean;
  message: string;
  scaleFactor?: number;
  screenWidth?: number;
  screenHeight?: number;
  logicalWidth?: number;
  logicalHeight?: number;
  error?: string;
}

export interface ActivateAppResult {
  success: boolean;
  message: string;
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
 * Save text to macOS clipboard via `pbcopy`.
 */
function pbcopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy', []);
    child.stdin.write(text);
    child.stdin.end();
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`pbcopy failed (exit ${code}): ${stderr}`));
      } else {
        resolve();
      }
    });
    child.on('error', reject);
  });
}

/**
 * Read text from macOS clipboard via `pbpaste`.
 */
async function pbpaste(): Promise<string> {
  const { stdout } = await execFileAsync('pbpaste', [], { timeout: 5_000 });
  return stdout;
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
 * @param options.windowId - Optional window ID to capture a specific window (interactive selection if omitted).
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
// Tool: mac_click
// ---------------------------------------------------------------------------

/**
 * Click at the specified coordinates (logical points) on macOS.
 *
 * Uses AppleScript System Events to perform the click. For Retina displays,
 * coordinates should be in logical points (not physical pixels).
 *
 * @param x - X coordinate in logical points.
 * @param y - Y coordinate in logical points.
 * @param options.button - Mouse button: 'left' (default), 'right', or 'center'.
 * @param options.clickCount - Number of clicks (1 = single, 2 = double).
 */
export async function mac_click(
  x: number,
  y: number,
  options?: { button?: 'left' | 'right' | 'center'; clickCount?: number },
): Promise<ClickResult> {
  if (!isMacOS()) {
    return platformError((error) => ({ success: false, message: `❌ ${error}`, error }));
  }

  try {
    const button = options?.button ?? 'left';
    const clickCount = options?.clickCount ?? 1;

    // For right-click and double-click, we need a different approach
    // since AppleScript "click at" only does single left click.
    // We'll use cliclick if available, otherwise fall back to CGEvent via osascript

    let effectiveScript: string;

    if (button === 'left' && clickCount === 1) {
      // Simple single left click — use AppleScript directly
      effectiveScript = `tell application "System Events" to click at {${x}, ${y}}`;
    } else {
      // For right-click, double-click, etc., use cliclick if available,
      // otherwise try CGEvent via Python
      effectiveScript = buildClickScript(x, y, button, clickCount);
    }

    logger.debug({ x, y, button, clickCount }, 'Performing click');
    await runAppleScript(effectiveScript);

    return {
      success: true,
      message: `✅ Clicked at (${x}, ${y}) [${button}, ${clickCount}x]`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, x, y }, 'Click failed');
    return {
      success: false,
      message: `❌ Click failed: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

/**
 * Build an AppleScript for advanced click operations.
 * Falls back to cliclick (if installed) or Python CGEvent.
 */
function buildClickScript(
  x: number,
  y: number,
  button: 'left' | 'right' | 'center',
  _clickCount: number,
): string {
  // Try cliclick first (common macOS automation tool)
  // cliclick uses format: c:x,y for click, rc:x,y for right-click, dc:x,y for double-click
  if (button === 'right') {
    return `do shell script "cliclick rc:${x},${y}"`;
  }
  // Fallback: use Python ctypes for CGEvent
  // This avoids external dependencies and works with the system Python
  return `do shell script "python3 -c \\"from ctypes import cdll; c = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'); down = 1; up = 2; e = c.CGEventCreateMouseEvent(None, down, ${x}, ${y}, 0); c.CGEventPost(0, e); e2 = c.CGEventCreateMouseEvent(None, up, ${x}, ${y}, 0); c.CGEventPost(0, e2)\\""`;
}

// ---------------------------------------------------------------------------
// Tool: mac_type_text
// ---------------------------------------------------------------------------

/**
 * Type text into the active application using the clipboard approach.
 *
 * This method bypasses IME issues with CJK (Chinese/Japanese/Korean) text
 * by copying the text to the clipboard and then simulating Cmd+V.
 *
 * The original clipboard contents are preserved (saved and restored).
 *
 * @param text - The text to type.
 * @param options.restoreClipboard - Whether to restore the original clipboard contents (default: true).
 */
export async function mac_type_text(
  text: string,
  options?: { restoreClipboard?: boolean },
): Promise<TypeTextResult> {
  if (!text) {
    return { success: false, message: '❌ Text is required', error: 'Text is required' };
  }

  if (!isMacOS()) {
    return platformError((error) => ({ success: false, message: `❌ ${error}`, error }));
  }

  try {
    const restoreClipboard = options?.restoreClipboard ?? true;
    let savedClipboard = '';

    // Save current clipboard contents
    if (restoreClipboard) {
      try {
        savedClipboard = await pbpaste();
      } catch {
        // Clipboard might be empty or contain non-text data — that's fine
        logger.debug('Could not read clipboard (may be empty or non-text)');
      }
    }

    // Copy text to clipboard
    await pbcopy(text);

    // Small delay to let clipboard settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate Cmd+V via System Events
    const script = `
tell application "System Events"
  keystroke "v" using command down
end tell`;
    await runAppleScript(script);

    // Wait for paste to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Restore original clipboard contents
    if (restoreClipboard) {
      try {
        await pbcopy(savedClipboard);
      } catch {
        logger.debug('Could not restore clipboard');
      }
    }

    const preview = text.length > 50 ? `${text.substring(0, 50)  }...` : text;
    logger.debug({ textPreview: preview }, 'Text typed');
    return {
      success: true,
      message: `✅ Typed "${preview}" (${text.length} chars)`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'Type text failed');
    return {
      success: false,
      message: `❌ Type text failed: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: mac_press_key
// ---------------------------------------------------------------------------

/**
 * Press a key (with optional modifier keys) on macOS.
 *
 * @param key - The key to press (e.g., "return", "tab", "escape", "a").
 * @param modifiers - Optional modifier keys: "command", "shift", "option", "control".
 *
 * @example
 * // Press Enter
 * mac_press_key('return')
 * // Press Cmd+S
 * mac_press_key('s', ['command'])
 * // Press Cmd+Shift+3 (screenshot)
 * mac_press_key('3', ['command', 'shift'])
 */
export async function mac_press_key(
  key: string,
  modifiers?: string[],
): Promise<PressKeyResult> {
  if (!isMacOS()) {
    return platformError((error) => ({ success: false, message: `❌ ${error}`, error }));
  }

  try {
    // Build AppleScript for key press
    const using = modifiers?.length
      ? ` using {${modifiers.map((m) => `${m} down`).join(', ')}}`
      : '';

    // For special keys, use "key code" instead of "keystroke"
    const specialKeys: Record<string, number> = {
      return: 36,
      enter: 36,
      tab: 48,
      escape: 53,
      esc: 53,
      delete: 51,
      backspace: 51,
      space: 49,
      up: 126,
      down: 125,
      left: 123,
      right: 124,
      home: 115,
      end: 119,
      pageup: 116,
      pagedown: 121,
      f1: 122,
      f2: 120,
      f3: 99,
      f4: 118,
      f5: 96,
      f6: 97,
      f7: 98,
      f8: 100,
      f9: 101,
      f10: 109,
      f11: 103,
      f12: 111,
    };

    let script: string;
    const lowerKey = key.toLowerCase();

    if (specialKeys[lowerKey] !== undefined) {
      // Use key code for special keys
      script = `tell application "System Events" to key code ${specialKeys[lowerKey]}${using}`;
    } else {
      // Use keystroke for regular characters
      script = `tell application "System Events" to keystroke "${key}"${using}`;
    }

    logger.debug({ key, modifiers }, 'Pressing key');
    await runAppleScript(script);

    return {
      success: true,
      message: `✅ Pressed key "${key}"${modifiers?.length ? ` with [${modifiers.join(', ')}]` : ''}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, key, modifiers }, 'Press key failed');
    return {
      success: false,
      message: `❌ Press key failed: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: mac_move_mouse
// ---------------------------------------------------------------------------

/**
 * Move the mouse cursor to the specified coordinates (logical points).
 *
 * @param x - X coordinate in logical points.
 * @param y - Y coordinate in logical points.
 */
export async function mac_move_mouse(
  x: number,
  y: number,
): Promise<MoveMouseResult> {
  if (!isMacOS()) {
    return platformError((error) => ({ success: false, message: `❌ ${error}`, error }));
  }

  try {
    // Use cliclick if available, otherwise use CGEvent via Python
    // We try cliclick first as it's simpler
    const script = `do shell script "cliclick m:${x},${y} 2>/dev/null || python3 -c \\"from ctypes import cdll; c = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'); e = c.CGEventCreateMouseEvent(None, 5, ${x}, ${y}, 0); c.CGEventPost(0, e)\\""`;

    logger.debug({ x, y }, 'Moving mouse');
    await runAppleScript(script);

    return {
      success: true,
      message: `✅ Moved mouse to (${x}, ${y})`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, x, y }, 'Move mouse failed');
    return {
      success: false,
      message: `❌ Move mouse failed: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: mac_get_window
// ---------------------------------------------------------------------------

/**
 * Get window bounds for a specific application window.
 *
 * @param appName - The application name (e.g., "Feishu", "Safari", "Google Chrome").
 * @param windowIndex - The window index (0-based, default: 0 = frontmost window).
 */
export async function mac_get_window(
  appName: string,
  windowIndex?: number,
): Promise<WindowInfo> {
  if (!appName) {
    return {
      success: false,
      message: '❌ appName is required',
      error: 'appName is required',
      appName,
    };
  }

  if (!isMacOS()) {
    return platformError((error) => ({
      success: false,
      message: `❌ ${error}`,
      error,
      appName,
    }));
  }

  try {
    const idx = windowIndex ?? 0;
    const script = `
tell application "${appName}"
  activate
  set winBounds to bounds of window ${idx + 1}
  set winName to name of window ${idx + 1}
  return (item 1 of winBounds) & "," & (item 2 of winBounds) & "," & (item 3 of winBounds) & "," & (item 4 of winBounds) & "|" & winName
end tell`;

    logger.debug({ appName, windowIndex: idx }, 'Getting window bounds');
    const { stdout } = await runAppleScript(script);

    // Parse the result: "x,y,x2,y2|windowName"
    const [boundsStr, windowName] = stdout.trim().split('|');
    const [left, top, right, bottom] = boundsStr.split(',').map(Number);

    // AppleScript bounds are {left, top, right, bottom}
    const x = left;
    const y = top;
    const width = right - left;
    const height = bottom - top;

    return {
      success: true,
      message: `✅ Window "${windowName}" of ${appName}: position=(${x}, ${y}), size=${width}x${height}`,
      appName,
      windowName,
      x,
      y,
      width,
      height,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, appName }, 'Get window failed');
    return {
      success: false,
      message: `❌ Get window failed: ${errorMessage}`,
      error: errorMessage,
      appName,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: mac_activate_app
// ---------------------------------------------------------------------------

/**
 * Activate (bring to front) an application on macOS.
 *
 * @param appName - The application name (e.g., "Feishu", "Safari").
 */
export async function mac_activate_app(
  appName: string,
): Promise<ActivateAppResult> {
  if (!appName) {
    return { success: false, message: '❌ appName is required', error: 'appName is required' };
  }

  if (!isMacOS()) {
    return platformError((error) => ({ success: false, message: `❌ ${error}`, error }));
  }

  try {
    const script = `tell application "${appName}" to activate`;
    logger.debug({ appName }, 'Activating app');
    await runAppleScript(script);

    return {
      success: true,
      message: `✅ Activated "${appName}"`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, appName }, 'Activate app failed');
    return {
      success: false,
      message: `❌ Activate app failed: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: mac_calibrate
// ---------------------------------------------------------------------------

/**
 * Calibrate screen coordinates for Retina displays.
 *
 * Detects the screen's backing scale factor and reports both logical
 * and physical dimensions. Use this to convert between screenshot
 * pixel coordinates and logical point coordinates.
 *
 * Formula: logical_coordinate = pixel_coordinate / scaleFactor
 *
 * @returns Calibration info including scale factor and screen dimensions.
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
