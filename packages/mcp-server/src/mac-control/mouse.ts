/**
 * Mouse control via macOS AppleScript / CGEvent.
 *
 * Uses osascript for high-level operations and can optionally invoke
 * CGEvent through Swift snippets for precise, low-level control.
 *
 * Issue #2216: Mouse automation for desktop interaction.
 * Community note (m13v): CGEvent coordinates are always in logical points.
 *
 * @module mac-control/mouse
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClickOptions, DragOptions, Point } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Click at the given coordinates (logical points).
 *
 * Uses AppleScript for the click event. For higher precision,
 * consider using CGEvent directly via a Swift helper.
 */
export async function click(x: number, y: number, options?: ClickOptions): Promise<void> {
  const button = options?.button ?? 'left';
  const clickCount = options?.clickCount ?? 1;

  // For right-click, we use CGEvent via osascript
  if (button === 'right' || clickCount > 1) {
    await cgEventClick(x, y, button, clickCount);
    return;
  }

  // Single left click via AppleScript (simpler, works in most cases)
  const script = `
    tell application "System Events"
      click at {${x}, ${y}}
    end tell
  `;

  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
  } catch (_error) {
    // Fallback to CGEvent if AppleScript fails (e.g., on Electron apps)
    await cgEventClick(x, y, button, clickCount);
  }
}

/**
 * Double-click at the given coordinates (logical points).
 */
export async function doubleClick(x: number, y: number): Promise<void> {
  await click(x, y, { clickCount: 2 });
}

/**
 * Right-click at the given coordinates (logical points).
 */
export async function rightClick(x: number, y: number): Promise<void> {
  await click(x, y, { button: 'right' });
}

/**
 * Drag from one point to another.
 *
 * Uses CGEvent to perform a press-drag-release sequence.
 */
export async function drag(from: Point, to: Point, options?: DragOptions): Promise<void> {
  const duration = options?.duration ?? 0.5;

  // CGEvent-based drag using osascript with Python (available on macOS)
  // Python's Quartz framework wraps CGEvent
  const script = `
import sys
try:
    from Quartz import CGEventCreateMouseEvent, CGEventPost, kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp, kCGEventLeftMouseDragged, kCGMouseButtonLeft, kCGHIDEventTap
    import time

    def move(x, y):
        event = CGEventCreateMouseEvent(None, kCGEventMouseMoved, (x, y), kCGMouseButtonLeft)
        CGEventPost(kCGHIDEventTap, event)

    def down(x, y):
        event = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, (x, y), kCGMouseButtonLeft)
        CGEventPost(kCGHIDEventTap, event)

    def up(x, y):
        event = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, (x, y), kCGMouseButtonLeft)
        CGEventPost(kCGHIDEventTap, event)

    move(${from.x}, ${from.y})
    time.sleep(0.05)
    down(${from.x}, ${from.y})

    steps = 10
    for i in range(1, steps + 1):
        t = i / steps
        cx = ${from.x} + (${to.x} - ${from.x}) * t
        cy = ${from.y} + (${to.y} - ${from.y}) * t
        event = CGEventCreateMouseEvent(None, kCGEventLeftMouseDragged, (cx, cy), kCGMouseButtonLeft)
        CGEventPost(kCGHIDEventTap, event)
        time.sleep(${duration} / steps)

    up(${to.x}, ${to.y})
except ImportError:
    print("ERROR: Quartz framework not available", file=sys.stderr)
    sys.exit(1)
`;

  await execFileAsync('python3', ['-c', script], { timeout: 10000 });
}

/**
 * Move the mouse to the given coordinates without clicking.
 */
export async function move(x: number, y: number): Promise<void> {
  const script = `
    tell application "System Events"
      set mouseLoc to {${x}, ${y}}
    end tell
  `;

  // Use Python/Quartz for reliable mouse move
  const pythonScript = `
from Quartz import CGEventCreateMouseEvent, CGEventPost, kCGEventMouseMoved, kCGMouseButtonLeft, kCGHIDEventTap
event = CGEventCreateMouseEvent(None, kCGEventMouseMoved, (${x}, ${y}), kCGMouseButtonLeft)
CGEventPost(kCGHIDEventTap, event)
`;

  try {
    await execFileAsync('python3', ['-c', pythonScript], { timeout: 5000 });
  } catch {
    // Fallback to osascript
    await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
  }
}

/**
 * Get current mouse position in logical points.
 */
export async function getMousePosition(): Promise<Point> {
  const script = `
    tell application "System Events"
      return (get mouse location)
    end tell
  `;

  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
  // Output format: "x, y"
  const parts = stdout.trim().split(',').map(s => parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some(isNaN)) {
    throw new Error(`Failed to parse mouse position: ${stdout.trim()}`);
  }
  return { x: parts[0], y: parts[1] };
}

/**
 * Internal: CGEvent-based click for cases where AppleScript is insufficient.
 * Uses Python Quartz bindings which wrap CGEvent.
 */
async function cgEventClick(x: number, y: number, button: 'left' | 'right', clickCount: number): Promise<void> {
  const buttonType = button === 'right' ? 'kCGMouseButtonRight' : 'kCGMouseButtonLeft';
  const downType = button === 'right' ? 'kCGEventRightMouseDown' : 'kCGEventLeftMouseDown';
  const upType = button === 'right' ? 'kCGEventRightMouseUp' : 'kCGEventLeftMouseUp';

  const script = `
from Quartz import (
    CGEventCreateMouseEvent, CGEventPost, CGEventSetIntegerValueField,
    kCGEventMouseMoved, ${downType}, ${upType},
    ${buttonType}, kCGHIDEventTap, kCGMouseEventClickState
)

# Move to position first
event = CGEventCreateMouseEvent(None, kCGEventMouseMoved, (${x}, ${y}), ${buttonType})
CGEventPost(kCGHIDEventTap, event)

# Perform clicks
for i in range(${clickCount}):
    down = CGEventCreateMouseEvent(None, ${downType}, (${x}, ${y}), ${buttonType})
    CGEventSetIntegerValueField(down, kCGMouseEventClickState, ${clickCount})
    CGEventPost(kCGHIDEventTap, down)

    up = CGEventCreateMouseEvent(None, ${upType}, (${x}, ${y}), ${buttonType})
    CGEventSetIntegerValueField(up, kCGMouseEventClickState, ${clickCount})
    CGEventPost(kCGHIDEventTap, up)
`;

  await execFileAsync('python3', ['-c', script], { timeout: 5000 });
}
