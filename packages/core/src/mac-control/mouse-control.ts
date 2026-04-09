/**
 * Mouse control utility for macOS.
 *
 * Uses the `cliclick` command-line tool to perform mouse operations:
 * click, double-click, right-click, drag, and move.
 *
 * `cliclick` works with logical (Cocoa) coordinates, matching the coordinate
 * space used by macOS window positions. On Retina displays, divide screenshot
 * pixel coordinates by the scale factor before passing to cliclick.
 *
 * Issue #2216: Mac 屏幕控制能力 - 辅助功能自动化模块
 * Phase 1: 封装 cliclick 鼠标控制
 */

import type { Point, ClickOptions } from './types.js';
import { CLICK_BUTTON_MAP, MODIFIER_MAP } from './types.js';
import { MacControlError, execWithTimeout } from './screen-capture.js';

/**
 * Default timeout for cliclick commands (ms).
 * Mouse operations should be fast, but accessibility permission prompts can block.
 */
const CLICLICK_TIMEOUT = 10_000;

/**
 * Execute a mouse click at the specified coordinates.
 *
 * Uses `cliclick` to perform the click. Coordinates are in logical (Cocoa) pixel space.
 *
 * @param x - Horizontal position in logical pixels
 * @param y - Vertical position in logical pixels
 * @param options - Click options (button, click count, modifiers)
 * @throws {MacControlError} If cliclick is not installed, not on macOS, or accessibility permission denied
 *
 * @example
 * ```typescript
 * // Simple left click
 * await click(500, 300);
 *
 * // Right click with shift modifier
 * await click(500, 300, { button: 'right', modifiers: ['shift'] });
 *
 * // Double click
 * await click(500, 300, { clicks: 2 });
 * ```
 */
export async function click(
  x: number,
  y: number,
  options: ClickOptions = {},
): Promise<void> {
  await ensureMacPlatform();

  const button = options.button ?? 'left';
  const clicks = options.clicks ?? 1;
  const modifiers = options.modifiers ?? [];

  // Build cliclick command string
  const parts: string[] = [];

  // Modifiers prefix (e.g., "cmd,shift:")
  if (modifiers.length > 0) {
    const modStr = modifiers
      .map(m => MODIFIER_MAP[m.toLowerCase()])
      .filter(Boolean)
      .join(',');
    if (modStr) {
      parts.push(`${modStr}:`);
    }
  }

  // Button prefix (empty string for left click)
  const buttonPrefix = CLICK_BUTTON_MAP[button] ?? '';
  const clickSuffix = clicks === 2 ? 'd' : ''; // 'd' = double click in cliclick

  // Coordinate: button_prefix + x,y + click_suffix
  parts.push(`${buttonPrefix}${Math.round(x)},${Math.round(y)}${clickSuffix}`);

  const command = parts.join('');

  await execCliclick(command);
}

/**
 * Move the mouse cursor to the specified coordinates without clicking.
 *
 * @param x - Horizontal position in logical pixels
 * @param y - Vertical position in logical pixels
 * @throws {MacControlError} If the operation fails
 */
export async function move(x: number, y: number): Promise<void> {
  await ensureMacPlatform();
  await execCliclick(`m:${Math.round(x)},${Math.round(y)}`);
}

/**
 * Perform a drag operation from one point to another.
 *
 * @param from - Starting position
 * @param to - Ending position
 * @param options - Click options for the initial mouse-down event
 * @throws {MacControlError} If the operation fails
 */
export async function drag(
  from: Point,
  to: Point,
  options: ClickOptions = {},
): Promise<void> {
  await ensureMacPlatform();

  const button = options.button ?? 'left';
  const modifiers = options.modifiers ?? [];

  // Build modifier prefix
  let modPrefix = '';
  if (modifiers.length > 0) {
    const modStr = modifiers
      .map(m => MODIFIER_MAP[m.toLowerCase()])
      .filter(Boolean)
      .join(',');
    if (modStr) modPrefix = `${modStr}:`;
  }

  const buttonPrefix = CLICK_BUTTON_MAP[button] ?? '';

  // cliclick drag syntax: dd:fromX,fromY/toX,toY
  // The 'dd' means drag (mouse down, move, mouse up)
  const command = `${modPrefix}dd:${buttonPrefix}${Math.round(from.x)},${Math.round(from.y)}/${Math.round(to.x)},${Math.round(to.y)}`;

  await execCliclick(command);
}

/**
 * Perform a double-click at the specified coordinates.
 * Convenience wrapper around {@link click} with `clicks: 2`.
 *
 * @param x - Horizontal position in logical pixels
 * @param y - Vertical position in logical pixels
 * @throws {MacControlError} If the operation fails
 */
export async function doubleClick(x: number, y: number): Promise<void> {
  await click(x, y, { clicks: 2 });
}

/**
 * Perform a right-click at the specified coordinates.
 * Convenience wrapper around {@link click} with `button: 'right'`.
 *
 * @param x - Horizontal position in logical pixels
 * @param y - Vertical position in logical pixels
 * @throws {MacControlError} If the operation fails
 */
export async function rightClick(x: number, y: number): Promise<void> {
  await click(x, y, { button: 'right' });
}

/**
 * Check if cliclick is available on the system.
 *
 * @returns true if cliclick is installed and accessible
 */
export async function isCliclickAvailable(): Promise<boolean> {
  try {
    await execWithTimeout('which', ['cliclick'], 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a cliclick command string.
 *
 * @internal
 */
async function execCliclick(command: string): Promise<void> {
  try {
    await execWithTimeout('cliclick', [command], CLICLICK_TIMEOUT);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('command not found') || message.includes('No such file')) {
      throw new MacControlError(
        `cliclick is not installed. Install with: brew install cliclick`,
        error instanceof Error ? error : undefined,
      );
    }

    if (message.includes('not allowed') || message.includes('accessibility') || message.includes('Permission')) {
      throw new MacControlError(
        `Accessibility permission denied for cliclick.\n` +
        `Please grant permission: System Settings → Privacy & Security → Accessibility`,
        error instanceof Error ? error : undefined,
      );
    }

    throw new MacControlError(`Mouse operation failed: ${message}`, error instanceof Error ? error : undefined);
  }
}

/**
 * Ensure the current platform is macOS.
 * @throws {MacControlError} If not on macOS
 */
async function ensureMacPlatform(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new MacControlError(
      `Mouse control is only supported on macOS, current platform: ${process.platform}`,
    );
  }
}
