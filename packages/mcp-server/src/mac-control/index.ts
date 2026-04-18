/**
 * MacControl — unified macOS automation module.
 *
 * Combines screenshot, mouse, keyboard, and accessibility APIs
 * into a single MacControlAPI implementation.
 *
 * Issue #2216: Mac screen control capability for desktop automation.
 *
 * @example
 * ```ts
 * import { MacControl } from './mac-control/index.js';
 *
 * const mac = new MacControl();
 *
 * // Take a screenshot
 * const shot = await mac.screenshot({ filePath: '/tmp/screen.png' });
 *
 * // Click at logical point coordinates
 * await mac.click(500, 300);
 *
 * // Type Chinese text
 * await mac.type('你好世界');
 * ```
 *
 * @module mac-control
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureScreenshot } from './screenshot.js';
import {
  click as doClick,
  doubleClick as doDoubleClick,
  rightClick as doRightClick,
  drag as doDrag,
  move as doMove,
  getMousePosition as doGetMousePosition,
} from './mouse.js';
import { typeText as doTypeText, pressKey as doPressKey } from './keyboard.js';
import { pixelToLogical } from './coordinates.js';
import type {
  MacControlAPI,
  ScreenshotOptions,
  ScreenshotResult,
  ClickOptions,
  DragOptions,
  Point,
  TypeOptions,
  ModifierKey,
  UIElement,
  QueryElementOptions,
  ApplicationInfo,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Main MacControl class implementing the MacControlAPI.
 *
 * All coordinates are in **logical points** (not pixels).
 * Use `pixelToLogical()` to convert screenshot pixel coordinates.
 */
export class MacControl implements MacControlAPI {
  // ─── Screenshot ─────────────────────────────────────────────────

  async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    return await captureScreenshot(options);
  }

  // ─── Mouse ──────────────────────────────────────────────────────

  async click(x: number, y: number, options?: ClickOptions): Promise<void> {
    await doClick(x, y, options);
  }

  async doubleClick(x: number, y: number): Promise<void> {
    await doDoubleClick(x, y);
  }

  async rightClick(x: number, y: number): Promise<void> {
    await doRightClick(x, y);
  }

  async drag(from: Point, to: Point, options?: DragOptions): Promise<void> {
    await doDrag(from, to, options);
  }

  async move(x: number, y: number): Promise<void> {
    await doMove(x, y);
  }

  async getMousePosition(): Promise<Point> {
    return await doGetMousePosition();
  }

  // ─── Keyboard ───────────────────────────────────────────────────

  async type(text: string, options?: TypeOptions): Promise<void> {
    await doTypeText(text, options);
  }

  async key(key: string, modifiers?: ModifierKey[]): Promise<void> {
    await doPressKey(key, modifiers);
  }

  async shortcut(key: string, modifiers: ModifierKey[]): Promise<void> {
    await doPressKey(key, modifiers);
  }

  // ─── Accessibility (UI Elements) ────────────────────────────────

  async queryElements(options?: QueryElementOptions): Promise<UIElement[]> {
    const roleFilter = options?.role ?? '';
    const titleFilter = options?.titleContains ?? '';

    const script = `
tell application "System Events"
  tell process 1
    set elements to every UI element
    set output to ""
    repeat with el in elements
      try
        set elRole to role of el
        set elTitle to name of el
        set elEnabled to enabled of el
        set elPosition to position of el
        set elSize to size of el
        if elPosition is missing value then set elPosition to {0, 0}
        if elSize is missing value then set elSize to {0, 0}
        set output to output & elRole & tab & elTitle & tab & (item 1 of elPosition as text) & "," & (item 2 of elPosition as text) & tab & (item 1 of elSize as text) & "," & (item 2 of elSize as text) & tab & (elEnabled as text) & linefeed
      end try
    end repeat
    return output
  end tell
end tell`;

    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 10000 });
      return parseUIElements(stdout, roleFilter, titleFilter);
    } catch {
      return [];
    }
  }

  async getFocusedElement(): Promise<UIElement | null> {
    const script = `
tell application "System Events"
  tell process 1
    set focused to value of attribute "AXFocusedUIElement" of it
    -- This approach may not work on all apps
    return missing value
  end tell
end tell`;

    try {
      await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
      return null; // Simplified — full impl needs AXUIElement FFI
    } catch {
      return null;
    }
  }

  // ─── Application ────────────────────────────────────────────────

  async getFrontmostApp(): Promise<ApplicationInfo> {
    const script = `
tell application "System Events"
  set frontApp to first process whose frontmost is true
  set appName to name of frontApp
  set appBundle to bundle identifier of frontApp
  try
    set appBounds to bounds of front window of frontApp
    set boundsStr to (item 1 of appBounds as text) & "," & (item 2 of appBounds as text) & "," & (item 3 of appBounds as text) & "," & (item 4 of appBounds as text)
  on error
    set boundsStr to ""
  end try
  return appName & "|" & appBundle & "|" & boundsStr
end tell`;

    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
    return parseAppInfo(stdout.trim());
  }

  async activateApp(nameOrBundleId: string): Promise<void> {
    const script = `
tell application "${nameOrBundleId.replace(/"/g, '\\"')}"
  activate
end tell`;
    await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
  }

  // ─── Coordinate Helpers ─────────────────────────────────────────

  /**
   * Convert screenshot pixel coordinates to logical points and click.
   * Convenience method combining coordinate conversion and click.
   */
  async clickAtPixel(pixelX: number, pixelY: number, options?: ClickOptions): Promise<void> {
    const [lx, ly] = await pixelToLogical(pixelX, pixelY);
    await doClick(lx, ly, options);
  }
}

// ─── Internal Helpers ──────────────────────────────────────────────

interface RawUIElement {
  role: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
}

function parseUIElements(output: string, roleFilter: string, titleFilter: string): UIElement[] {
  const lines = output.split('\n').filter(l => l.trim());
  const elements: UIElement[] = [];

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 5) {continue;}

    const raw: RawUIElement = {
      role: parts[0],
      title: parts[1],
      x: parseFloat(parts[2].split(',')[0]),
      y: parseFloat(parts[2].split(',')[1]),
      width: parseFloat(parts[3].split(',')[0]),
      height: parseFloat(parts[3].split(',')[1]),
      enabled: parts[4].trim().toLowerCase() === 'true',
    };

    // Apply filters
    if (roleFilter && !raw.role.includes(roleFilter)) {continue;}
    if (titleFilter && !(raw.title ?? '').includes(titleFilter)) {continue;}

    elements.push({
      role: raw.role,
      title: raw.title || undefined,
      rect: { x: raw.x, y: raw.y, width: raw.width, height: raw.height },
      enabled: raw.enabled,
    });
  }

  return elements;
}

function parseAppInfo(raw: string): ApplicationInfo {
  const parts = raw.split('|');
  const boundsStr = parts[2] ?? '';
  let windowBounds: ApplicationInfo['windowBounds'];

  if (boundsStr) {
    const coords = boundsStr.split(',').map(Number);
    if (coords.length === 4 && coords.every(c => !isNaN(c))) {
      windowBounds = {
        x: coords[0], y: coords[1],
        width: coords[2] - coords[0],
        height: coords[3] - coords[1],
      };
    }
  }

  return {
    name: parts[0] ?? '',
    bundleId: parts[1] ?? '',
    frontmost: true,
    windowBounds,
  };
}

// Re-export types and utilities
export type { MacControlAPI } from './types.js';
export { pixelToLogical, logicalToPixel, getBackingScaleFactor, clearScaleCache, setScaleFactor } from './coordinates.js';
export { captureScreenshot } from './screenshot.js';
export { click, doubleClick, rightClick, drag, move, getMousePosition } from './mouse.js';
export { typeText, pressKey } from './keyboard.js';
