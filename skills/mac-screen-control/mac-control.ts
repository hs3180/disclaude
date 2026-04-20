#!/usr/bin/env tsx
/**
 * skills/mac-screen-control/mac-control.ts — macOS screen/keyboard/mouse control CLI.
 *
 * Provides desktop automation on macOS using native tools:
 *   - screencapture (screenshots)
 *   - osascript / AppleScript (window management, app activation, Accessibility API)
 *   - cliclick or CGEvent via osascript (mouse/keyboard events)
 *   - pbcopy + Cmd+V (CJK text input)
 *
 * Usage:
 *   npx tsx skills/mac-screen-control/mac-control.ts --action <action> [options]
 *
 * Actions:
 *   screenshot         Take a screenshot
 *   click              Click at (x, y)
 *   move               Move mouse to (x, y)
 *   drag               Drag from (x1,y1) to (x2,y2)
 *   type               Type text (supports CJK via clipboard paste)
 *   key                Press a key with optional modifiers
 *   get-window         Get window bounds for an app
 *   activate-app       Bring an app to the foreground
 *   find-element       Find UI elements via Accessibility API
 *   calibrate          Detect Retina scaling factor
 *
 * Exit codes:
 *   0 — success
 *   1 — invalid arguments or missing dependencies
 *   2 — action failed
 */

import { execFile, exec } from 'node:child_process';
import { writeFile, unlink, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActionResult {
  success: boolean;
  action: string;
  data?: Record<string, unknown>;
  error?: string;
}

type MouseButton = 'left' | 'right' | 'double';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

function requireArg(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (!value) {
    outputError('missing-arg', `Missing required argument: --${name}`);
    process.exit(1);
  }
  return value;
}

function parseIntArg(args: Record<string, string>, name: string): number | undefined {
  const value = args[name];
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    outputError('invalid-arg', `Invalid integer for --${name}: ${value}`);
    process.exit(1);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function outputResult(action: string, data: Record<string, unknown>): never {
  const result: ActionResult = { success: true, action, data };
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

function outputError(action: string, error: string): never {
  const result: ActionResult = { success: false, action, error };
  console.error(JSON.stringify(result, null, 2));
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Dependency checks
// ---------------------------------------------------------------------------

async function checkMacOS(): Promise<void> {
  if (process.platform !== 'darwin') {
    outputError('init', 'This skill requires macOS. Current platform: ' + process.platform);
  }
}

async function checkCommand(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureCliclick(): Promise<void> {
  const hasCliclick = await checkCommand('cliclick');
  if (!hasCliclick) {
    outputError('init', 'cliclick not found. Install with: brew install cliclick');
  }
}

// ---------------------------------------------------------------------------
// Action: screenshot
// ---------------------------------------------------------------------------

async function actionScreenshot(args: Record<string, string>): Promise<void> {
  const output = args.output || `/tmp/screenshot-${Date.now()}.png`;
  const outputPath = resolve(output);

  const cmdArgs: string[] = ['-x', outputPath]; // -x = no sound

  // Region: --region x,y,w,h
  if (args.region) {
    const parts = args.region.split(',').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) {
      outputError('screenshot', 'Invalid region format. Use: x,y,w,h');
    }
    const [x, y, w, h] = parts;
    // screencapture -R x,y,w,h captures a specific region
    cmdArgs.splice(1, 0, '-R', `${x},${y},${w},${h}`);
  }

  try {
    await execFileAsync('screencapture', cmdArgs, { timeout: 10000 });

    // Get image dimensions using sips
    let width = 0;
    let height = 0;
    try {
      const { stdout } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', outputPath]);
      const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
      const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
      if (widthMatch) width = parseInt(widthMatch[1], 10);
      if (heightMatch) height = parseInt(heightMatch[1], 10);
    } catch {
      // sips not available, skip dimensions
    }

    outputResult('screenshot', { path: outputPath, width, height });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputError('screenshot', `Failed to capture screenshot: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Action: click
// ---------------------------------------------------------------------------

async function actionClick(args: Record<string, string>): Promise<void> {
  const x = requireArg(args, 'x');
  const y = requireArg(args, 'y');
  const button: MouseButton = (args.button as MouseButton) || 'left';

  await ensureCliclick();

  let cliclickCmd: string;
  switch (button) {
    case 'right':
      cliclickCmd = `rc:${x},${y}`;
      break;
    case 'double':
      cliclickCmd = `dc:${x},${y}`;
      break;
    case 'left':
    default:
      cliclickCmd = `c:${x},${y}`;
      break;
  }

  try {
    await execFileAsync('cliclick', [cliclickCmd], { timeout: 5000 });
    outputResult('click', { x: parseInt(x, 10), y: parseInt(y, 10), button });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputError('click', `Failed to click: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Action: move
// ---------------------------------------------------------------------------

async function actionMove(args: Record<string, string>): Promise<void> {
  const x = requireArg(args, 'x');
  const y = requireArg(args, 'y');

  await ensureCliclick();

  try {
    await execFileAsync('cliclick', [`m:${x},${y}`], { timeout: 5000 });
    outputResult('move', { x: parseInt(x, 10), y: parseInt(y, 10) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputError('move', `Failed to move mouse: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Action: drag
// ---------------------------------------------------------------------------

async function actionDrag(args: Record<string, string>): Promise<void> {
  const fromX = requireArg(args, 'from-x');
  const fromY = requireArg(args, 'from-y');
  const toX = requireArg(args, 'to-x');
  const toY = requireArg(args, 'to-y');

  await ensureCliclick();

  try {
    // cliclick drag: dd:x,y (mouse down at from, move to to, mouse up)
    // cliclick doesn't have a direct drag command, so we use:
    // 1. Move to start position
    // 2. Mouse down
    // 3. Move to end position
    // 4. Mouse up
    // Use AppleScript for drag since cliclick doesn't support it natively
    const script = `
      use framework "CoreGraphics"
      -- Move to start position and click-drag to end position
      do shell script "cliclick m:${fromX},${fromY}"
      delay 0.05
      do shell script "cliclick dd:${fromX},${fromY}"
      delay 0.1
      do shell script "cliclick m:${toX},${toY}"
      delay 0.1
      do shell script "cliclick du:${toX},${toY}"
    `;

    await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
    outputResult('drag', {
      from: { x: parseInt(fromX, 10), y: parseInt(fromY, 10) },
      to: { x: parseInt(toX, 10), y: parseInt(toY, 10) },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputError('drag', `Failed to drag: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Action: type (supports CJK via clipboard paste)
// ---------------------------------------------------------------------------

async function actionType(args: Record<string, string>): Promise<void> {
  const text = requireArg(args, 'text');

  // Detect if text contains non-ASCII characters
  const isAsciiOnly = /^[\x00-\x7F]*$/.test(text);

  try {
    if (isAsciiOnly) {
      // For ASCII text, use cliclick type directly
      const hasCliclick = await checkCommand('cliclick');
      if (hasCliclick) {
        // cliclick uses : to escape special characters
        const escaped = text.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
        await execFileAsync('cliclick', [`t:${escaped}`], { timeout: 5000 });
      } else {
        // Fallback to osascript keystroke
        const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await execFileAsync('osascript', [
          '-e', `tell application "System Events" to keystroke "${escaped}"`,
        ], { timeout: 5000 });
      }
    } else {
      // For non-ASCII (CJK, emoji, etc.), use clipboard paste method
      // This is the most reliable way to input Chinese text on macOS

      // Save current clipboard
      let savedClipboard = '';
      try {
        const { stdout } = await execFileAsync('pbpaste', [], { timeout: 3000 });
        savedClipboard = stdout;
      } catch {
        // Clipboard might be empty or contain non-text data
      }

      // Copy text to clipboard using shell pipe (pbcopy reads from stdin)
      const tmpFile = `/tmp/mac-control-clipboard-${Date.now()}.txt`;
      await writeFile(tmpFile, text, 'utf-8');
      await execAsync(`cat "${tmpFile}" | pbcopy`, { timeout: 3000 });

      // Small delay to ensure clipboard is ready
      await new Promise(resolve => setTimeout(resolve, 50));

      // Paste with Cmd+V
      await execFileAsync('osascript', [
        '-e', 'tell application "System Events" to keystroke "v" using command down',
      ], { timeout: 5000 });

      // Restore clipboard (async, don't wait)
      setTimeout(async () => {
        try {
          await execAsync(`printf '%s' '${savedClipboard.replace(/'/g, "'\\''")}' | pbcopy`, { timeout: 3000 });
        } catch {
          // Best effort restore
        }
        try {
          await unlink(tmpFile);
        } catch {
          // Ignore cleanup errors
        }
      }, 200);
    }

    outputResult('type', { text: text.slice(0, 50) + (text.length > 50 ? '...' : ''), method: isAsciiOnly ? 'direct' : 'clipboard-paste' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputError('type', `Failed to type text: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Action: key
// ---------------------------------------------------------------------------

/** Map common key names to AppleScript key codes */
const KEY_MAP: Record<string, string> = {
  enter: 'return',
  return: 'return',
  tab: 'tab',
  escape: 'escape',
  esc: 'escape',
  space: 'space',
  delete: 'delete',
  backspace: 'delete',
  up: 'key code 126',
  down: 'key code 125',
  left: 'key code 123',
  right: 'key code 124',
  home: 'key code 115',
  end: 'key code 119',
  pageup: 'key code 116',
  pagedown: 'key code 121',
  f1: 'key code 122',
  f2: 'key code 120',
  f3: 'key code 99',
  f4: 'key code 118',
  f5: 'key code 96',
  f6: 'key code 97',
  f7: 'key code 98',
  f8: 'key code 100',
  f9: 'key code 101',
  f10: 'key code 109',
  f11: 'key code 103',
  f12: 'key code 111',
};

/** Map modifier names to AppleScript syntax */
const MODIFIER_MAP: Record<string, string> = {
  cmd: 'command down',
  command: 'command down',
  ctrl: 'control down',
  control: 'control down',
  alt: 'option down',
  option: 'option down',
  shift: 'shift down',
};

async function actionKey(args: Record<string, string>): Promise<void> {
  const key = requireArg(args, 'key').toLowerCase();
  const modifiers = args.modifiers
    ? args.modifiers.split(',').map(m => m.trim().toLowerCase())
    : [];

  try {
    const keyExpr = KEY_MAP[key] || `key code ${key}` || `keystroke "${key}"`;

    // Build modifier string
    const modParts = modifiers
      .map(m => MODIFIER_MAP[m])
      .filter(Boolean);
    const usingClause = modParts.length > 0 ? ` using {${modParts.join(', ')}}` : '';

    // Check if it's a key code expression or a keystroke
    let script: string;
    if (keyExpr.startsWith('key code')) {
      script = `tell application "System Events" to ${keyExpr}${usingClause}`;
    } else {
      script = `tell application "System Events" to keystroke "${keyExpr}"${usingClause}`;
    }

    await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
    outputResult('key', { key, modifiers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputError('key', `Failed to press key: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Action: get-window
// ---------------------------------------------------------------------------

async function actionGetWindow(args: Record<string, string>): Promise<void> {
  const app = requireArg(args, 'app');

  const script = `
    tell application "${app}"
      activate
      set winBounds to bounds of front window
      set x to item 1 of winBounds
      set y to item 2 of winBounds
      set w to (item 3 of winBounds) - x
      set h to (item 4 of winBounds) - y
      return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
    end tell
  `;

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
    const parts = stdout.trim().split(',').map(Number);

    if (parts.length !== 4 || parts.some(isNaN)) {
      outputError('get-window', `Unexpected output: ${stdout.trim()}`);
    }

    const [x, y, w, h] = parts;
    outputResult('get-window', { app, x, y, width: w, height: h });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputError('get-window', `Failed to get window bounds for "${app}": ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Action: activate-app
// ---------------------------------------------------------------------------

async function actionActivateApp(args: Record<string, string>): Promise<void> {
  const app = requireArg(args, 'app');

  const script = `
    tell application "${app}"
      activate
    end tell
  `;

  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
    // Small delay for app to come to foreground
    await new Promise(resolve => setTimeout(resolve, 200));
    outputResult('activate-app', { app });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputError('activate-app', `Failed to activate "${app}": ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Action: find-element (Accessibility API)
// ---------------------------------------------------------------------------

async function actionFindElement(args: Record<string, string>): Promise<void> {
  const app = requireArg(args, 'app');
  const role = args.role || '';
  const title = args.title || '';
  const maxDepth = parseIntArg(args, 'max-depth') || 5;

  // Build AppleScript to traverse accessibility tree
  const roleFilter = role ? ` whose role is "${role}"` : '';
  const titleFilter = title ? ` whose name contains "${title}"` : '';

  const script = `
    tell application "System Events"
      tell process "${app}"
        set output to ""
        set allElements to every UI element of front window${roleFilter}${titleFilter}
        repeat with elem in allElements
          try
            set elemRole to role of elem
            set elemName to name of elem
            set elemPos to position of elem
            set elemSize to size of elem
            set elemDesc to description of elem
            set x to item 1 of elemPos
            set y to item 2 of elemPos
            set w to item 1 of elemSize
            set h to item 2 of elemSize
            set output to output & elemRole & "|" & elemName & "|" & elemDesc & "|" & (x as text) & "," & (y as text) & "|" & (w as text) & "," & (h as text) & linefeed
          end try
        end repeat
        return output
      end tell
    end tell
  `;

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 10000 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    const elements = lines.map(line => {
      const [elemRole, elemName, elemDesc, pos, size] = line.split('|');
      const [x, y] = pos.split(',').map(Number);
      const [w, h] = size.split(',').map(Number);
      return { role: elemRole, name: elemName, description: elemDesc, x, y, width: w, height: h };
    });

    outputResult('find-element', { app, elements, count: elements.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputError('find-element', `Failed to find elements in "${app}": ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Action: calibrate
// ---------------------------------------------------------------------------

async function actionCalibrate(): Promise<void> {
  const script = `
    use framework "AppKit"
    set mainScreen to current application's NSScreen's mainScreen()
    set frame to mainScreen's frame()
    set backing to mainScreen's backingScaleFactor()
    set screenW to (item 1 of frame's |size|) as text
    set screenH to (item 2 of frame's |size|) as text
    set pixelW to (screenW * backing) as text
    set pixelH to (screenH * backing) as text
    set scaleFactor to backing as text
    return scaleFactor & "," & screenW & "," & screenH & "," & pixelW & "," & pixelH
  `;

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
    const parts = stdout.trim().split(',').map(Number);

    if (parts.length < 2) {
      outputError('calibrate', `Unexpected output: ${stdout.trim()}`);
    }

    const [scaleFactor, screenW, screenH, pixelW, pixelH] = parts;

    outputResult('calibrate', {
      scaleFactor: scaleFactor || 2,
      logicalWidth: screenW,
      logicalHeight: screenH,
      pixelWidth: pixelW || screenW * (scaleFactor || 2),
      pixelHeight: pixelH || screenH * (scaleFactor || 2),
      isRetina: (scaleFactor || 2) > 1,
      note: scaleFactor > 1
        ? 'Retina display detected. Screenshot pixel coordinates should be divided by scaleFactor to get logical coordinates for clicking.'
        : 'Standard display. Coordinates match 1:1.',
    });
  } catch (err) {
    // Fallback: try using system_profiler
    try {
      const { stdout: profOutput } = await execAsync(
        'system_profiler SPDisplaysDataType 2>/dev/null | grep "Retina"',
        { timeout: 5000 },
      );
      const isRetina = profOutput.includes('Retina');
      outputResult('calibrate', {
        scaleFactor: isRetina ? 2 : 1,
        isRetina,
        note: isRetina
          ? 'Retina display detected (fallback detection). Assume scaleFactor=2.'
          : 'Standard display detected (fallback detection).',
      });
    } catch {
      outputError('calibrate', 'Failed to detect display scaling. Error: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await checkMacOS();

  const args = parseArgs(process.argv);
  const action = args.action;

  if (!action) {
    console.error('Usage: mac-control.ts --action <action> [options]');
    console.error('Actions: screenshot, click, move, drag, type, key, get-window, activate-app, find-element, calibrate');
    process.exit(1);
  }

  switch (action) {
    case 'screenshot':
      return actionScreenshot(args);
    case 'click':
      return actionClick(args);
    case 'move':
      return actionMove(args);
    case 'drag':
      return actionDrag(args);
    case 'type':
      return actionType(args);
    case 'key':
      return actionKey(args);
    case 'get-window':
      return actionGetWindow(args);
    case 'activate-app':
      return actionActivateApp(args);
    case 'find-element':
      return actionFindElement(args);
    case 'calibrate':
      return actionCalibrate();
    default:
      outputError('init', `Unknown action: ${action}. Supported: screenshot, click, move, drag, type, key, get-window, activate-app, find-element, calibrate`);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ success: false, action: 'fatal', error: msg }, null, 2));
  process.exit(1);
});
