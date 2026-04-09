/**
 * Window information utility for macOS.
 *
 * Uses `osascript` with System Events to query application window positions,
 * sizes, titles, and frontmost status. All coordinates are in logical
 * (Cocoa) pixel space, consistent with cliclick's coordinate system.
 *
 * Issue #2216: Mac 屏幕控制能力 - 辅助功能自动化模块
 * Phase 1: 窗口 bounds 获取
 */

import type { WindowInfo, Rect } from './types.js';
import { MacControlError, execWithTimeout } from './screen-capture.js';

/**
 * Default timeout for osascript commands (ms).
 * AppleScript execution can be slow due to IPC with System Events.
 */
const OSASCRIPT_TIMEOUT = 10_000;

/**
 * Get the bounds (position and size) of an application window.
 *
 * Uses `osascript` with System Events to query window properties.
 * Coordinates are in logical (Cocoa) pixels: origin is at the
 * bottom-left of the main display (macOS convention).
 *
 * @param appName - Application process name (e.g., 'Feishu', 'Google Chrome')
 * @param windowIndex - Window index among the app's windows (1-based, default: 1)
 * @returns WindowInfo with bounds, title, and frontmost status
 * @throws {MacControlError} If the app is not running, no windows found, or permission denied
 *
 * @example
 * ```typescript
 * const window = await getAppWindow('Feishu');
 * console.log(window.bounds); // { x: 100, y: 100, width: 1200, height: 800 }
 * ```
 */
export async function getAppWindow(
  appName: string,
  windowIndex: number = 1,
): Promise<WindowInfo> {
  await ensureMacPlatform();

  // AppleScript to get window info from System Events
  // Returns tab-delimited: title\tboundsX,boundsY,boundsWidth,boundsHeight\tisFrontmost
  const script = `
    tell application "System Events"
      set appProcess to first process whose name is "${escapeAppleScript(appName)}"
      set windowCount to count of windows of appProcess
      if windowCount < ${windowIndex} then
        return "ERROR: Window index ${windowIndex} out of range (app has " & windowCount & " windows)"
      end if
      set targetWindow to window ${windowIndex} of appProcess
      set windowTitle to name of targetWindow
      set windowBounds to position of targetWindow
      set windowSize to size of targetWindow
      set isFront to frontmost of appProcess
      return windowTitle & "\\t" & (item 1 of windowBounds as text) & "," & (item 2 of windowBounds as text) & "," & (item 1 of windowSize as text) & "," & (item 2 of windowSize as text) & "\\t" & (isFront as text)
    end tell
  `.trim();

  const output = await execOsascript(script);

  if (output.startsWith('ERROR:')) {
    throw new MacControlError(output.substring(6).trim());
  }

  const parts = output.split('\t');
  if (parts.length !== 3) {
    throw new MacControlError(
      `Unexpected output format from osascript: "${output}"`,
    );
  }

  const title = parts[0];
  const [bx, by, bw, bh] = parts[1].split(',').map(Number);
  const isFrontmost = parts[2].trim() === 'true';

  if ([bx, by, bw, bh].some(v => isNaN(v))) {
    throw new MacControlError(
      `Failed to parse window bounds from osascript output: "${parts[1]}"`,
    );
  }

  return {
    appName,
    title,
    bounds: { x: bx, y: by, width: bw, height: bh },
    isFrontmost,
    windowIndex,
  };
}

/**
 * Activate (bring to front) an application by name.
 *
 * @param appName - Application process name (e.g., 'Feishu')
 * @throws {MacControlError} If the app cannot be activated
 */
export async function activateApp(appName: string): Promise<void> {
  await ensureMacPlatform();

  const script = `tell application "${escapeAppleScript(appName)}" to activate`;
  await execOsascript(script);
}

/**
 * List all visible windows of an application.
 *
 * @param appName - Application process name
 * @returns Array of WindowInfo for all windows of the app
 */
export async function listAppWindows(appName: string): Promise<WindowInfo[]> {
  await ensureMacPlatform();

  const script = `
    tell application "System Events"
      set appProcess to first process whose name is "${escapeAppleScript(appName)}"
      set windowCount to count of windows of appProcess
      set result to ""
      repeat with i from 1 to windowCount
        set targetWindow to window i of appProcess
        set windowTitle to name of targetWindow
        set windowBounds to position of targetWindow
        set windowSize to size of targetWindow
        set isFront to frontmost of appProcess
        set result to result & windowTitle & "\\t" & (item 1 of windowBounds as text) & "," & (item 2 of windowBounds as text) & "," & (item 1 of windowSize as text) & "," & (item 2 of windowSize as text) & "\\t" & (isFront as text) & "\\n"
      end repeat
      return result
    end tell
  `.trim();

  const output = await execOsascript(script);
  const lines = output.trim().split('\n').filter(line => line.trim());

  return lines.map((line, index) => {
    const parts = line.split('\t');
    if (parts.length !== 3) {
      return {
        appName,
        title: `Window ${index + 1}`,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        isFrontmost: false,
        windowIndex: index + 1,
      };
    }

    const title = parts[0];
    const [bx, by, bw, bh] = parts[1].split(',').map(Number);
    const isFrontmost = parts[2].trim() === 'true';

    return {
      appName,
      title,
      bounds: { x: isNaN(bx) ? 0 : bx, y: isNaN(by) ? 0 : by, width: isNaN(bw) ? 0 : bw, height: isNaN(bh) ? 0 : bh },
      isFrontmost,
      windowIndex: index + 1,
    };
  });
}

/**
 * Get the main display resolution in logical (Cocoa) pixels.
 *
 * @returns Rect with width and height of the main display
 */
export async function getScreenResolution(): Promise<Rect> {
  await ensureMacPlatform();

  // Use system_profiler to get display info — works without Screen Recording permission
  const script = `
    tell application "System Events"
      set displayInfo to do shell script "system_profiler SPDisplaysDataType 2>/dev/null | grep -A1 'Resolution' | head -2"
      return displayInfo
    end tell
  `.trim();

  try {
    const output = await execOsascript(script);
    // Parse resolution from system_profiler output like "Resolution: 2560 x 1600"
    const match = output.match(/(\d+)\s*x\s*(\d+)/i);
    if (match) {
      return { x: 0, y: 0, width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
    }
  } catch {
    // Fall through to alternative method
  }

  // Fallback: use osascript to get screen size from window server
  const fallbackScript = `
    tell application "System Events"
      set screenBounds to bounds of window of desktop
      return (item 3 of screenBounds as text) & "," & (item 4 of screenBounds as text)
    end tell
  `.trim();

  const output = await execOsascript(fallbackScript);
  const [width, height] = output.split(',').map(Number);

  if (isNaN(width) || isNaN(height)) {
    throw new MacControlError(`Failed to parse screen resolution: "${output}"`);
  }

  return { x: 0, y: 0, width, height };
}

/**
 * Execute an osascript command.
 *
 * @internal
 */
async function execOsascript(script: string): Promise<string> {
  try {
    const output = await execWithTimeout('osascript', ['-e', script], OSASCRIPT_TIMEOUT);
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('not allowed') || message.includes('accessibility')) {
      throw new MacControlError(
        `Accessibility permission denied for System Events.\n` +
        `Please grant permission: System Settings → Privacy & Security → Accessibility`,
        error instanceof Error ? error : undefined,
      );
    }

    if (message.includes('not found') || message.includes('Application isn')) {
      throw new MacControlError(
        `Application "${script.match(/name is "([^"]+)"/)?.[1] ?? 'unknown'}" is not running.`,
        error instanceof Error ? error : undefined,
      );
    }

    throw new MacControlError(`Window info query failed: ${message}`, error instanceof Error ? error : undefined);
  }
}

/**
 * Escape special characters in strings used within AppleScript.
 *
 * @internal
 */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Ensure the current platform is macOS.
 * @throws {MacControlError} If not on macOS
 */
async function ensureMacPlatform(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new MacControlError(
      `Window info is only supported on macOS, current platform: ${process.platform}`,
    );
  }
}
