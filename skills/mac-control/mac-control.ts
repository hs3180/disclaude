#!/usr/bin/env tsx
/**
 * skills/mac-control/mac-control.ts — macOS desktop automation via shell commands.
 *
 * Provides screenshot, mouse, keyboard, and window management operations
 * using cliclick, osascript, screencapture, and pbcopy/pbpaste.
 *
 * Environment variables:
 *   MAC_OP          Operation to perform (required)
 *   MAC_SKIP_CHECK  Set to '1' to skip tool availability check (for testing)
 *
 * Exit codes:
 *   0 — success (JSON result on stdout)
 *   1 — validation or execution error
 *
 * Operations:
 *   screenshot      Take a screenshot
 *   click           Click at coordinates
 *   move            Move mouse to coordinates
 *   drag            Drag from one point to another
 *   type            Type text (supports CJK via clipboard)
 *   key             Press a key with optional modifiers
 *   get-window      Get window bounds for an application
 *   activate-app    Bring an application to the foreground
 *   calibrate       Get display scale factor and info
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const EXEC_TIMEOUT_MS = 30_000;
const CLIPBOARD_BACKUP_PATH = resolve(tmpdir(), 'mac-control-clipboard-backup.txt');

/** Supported operations */
const VALID_OPS = new Set([
  'screenshot',
  'click',
  'move',
  'drag',
  'type',
  'key',
  'get-window',
  'activate-app',
  'calibrate',
]);

/** Supported click buttons */
const VALID_BUTTONS = new Set(['left', 'right', 'center']);

/** Supported modifier keys */
const VALID_MODIFIERS = new Set(['command', 'shift', 'control', 'option']);

/** Supported type modes */
const VALID_TYPE_MODES = new Set(['clipboard', 'keystroke']);

/** Key name mappings for osascript */
const KEY_MAP: Record<string, string> = {
  enter: 'return',
  return: 'return',
  tab: 'tab',
  space: 'space',
  escape: 'escape',
  esc: 'escape',
  delete: 'delete',
  backspace: 'delete',
  up: 'up arrow',
  down: 'down arrow',
  left: 'left arrow',
  right: 'right arrow',
  home: 'home',
  end: 'end',
  pageup: 'page up',
  pagedown: 'page down',
  f1: 'f1',
  f2: 'f2',
  f3: 'f3',
  f4: 'f4',
  f5: 'f5',
  f6: 'f6',
  f7: 'f7',
  f8: 'f8',
  f9: 'f9',
  f10: 'f10',
  f11: 'f11',
  f12: 'f12',
};

// ---- Helpers ----

function exitWithError(msg: string): never {
  const result = JSON.stringify({ success: false, error: msg });
  console.log(result);
  process.exit(1);
}

function exitWithResult(data: Record<string, unknown>): never {
  console.log(JSON.stringify({ success: true, ...data }));
  process.exit(0);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    exitWithError(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function parseIntOrThrow(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    exitWithError(`Invalid ${name}: must be an integer, got '${value}'`);
  }
  return parsed;
}

async function runCommand(
  command: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options?.timeout ?? EXEC_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    throw new Error(
      (execErr.stderr ?? execErr.message ?? 'unknown error')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
}

// ---- Platform Detection ----

function detectPlatform(): 'macos' | 'other' {
  return process.platform === 'darwin' ? 'macos' : 'other';
}

async function checkToolAvailable(tool: string): Promise<boolean> {
  try {
    await runCommand('which', [tool], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ---- Clipboard Helpers ----

/**
 * Save current clipboard contents to a temp file.
 * Returns true if clipboard had content, false if empty or error.
 */
async function saveClipboard(): Promise<boolean> {
  try {
    const { stdout } = await runCommand('pbpaste', []);
    if (stdout && stdout.length > 0) {
      await writeFile(CLIPBOARD_BACKUP_PATH, stdout, 'utf-8');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Restore clipboard contents from the temp backup file.
 */
async function restoreClipboard(): Promise<void> {
  try {
    if (existsSync(CLIPBOARD_BACKUP_PATH)) {
      const content = await readFile(CLIPBOARD_BACKUP_PATH, 'utf-8');
      await runCommand('pbcopy', [], { timeout: 5000 });
      // pbcopy reads from stdin - use a different approach
      const { execFile: execFileCb } = require('node:child_process');
      const proc = execFileCb('pbcopy', [], { timeout: 5000 });
      if (proc.stdin) {
        proc.stdin.write(content);
        proc.stdin.end();
      }
      await unlink(CLIPBOARD_BACKUP_PATH).catch(() => {});
    }
  } catch {
    // Best effort - don't fail the operation
  }
}

// ---- Operations ----

/**
 * Take a screenshot using macOS screencapture.
 */
async function opScreenshot(): Promise<void> {
  const outputPath = requireEnv('MAC_OUTPUT');
  const region = optionalEnv('MAC_REGION', '');
  const showCursor = optionalEnv('MAC_SHOW_CURSOR', 'false') === 'true';

  const args: string[] = ['-x']; // No sound

  if (showCursor) {
    args.push('-C'); // Show cursor
  }

  if (region) {
    // Parse region: x,y,width,height
    const parts = region.split(',').map((p) => p.trim());
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(Number(p)))) {
      exitWithError('Invalid MAC_REGION format. Expected: x,y,width,height');
    }
    args.push('-R', region);
  }

  args.push(outputPath);

  await runCommand('screencapture', args);

  exitWithResult({
    path: outputPath,
    region: region || 'fullscreen',
    cursor: showCursor,
  });
}

/**
 * Click at coordinates using cliclick.
 */
async function opClick(): Promise<void> {
  const x = parseIntOrThrow(requireEnv('MAC_X'), 'MAC_X');
  const y = parseIntOrThrow(requireEnv('MAC_Y'), 'MAC_Y');
  const button = optionalEnv('MAC_BUTTON', 'left');
  const clicks = parseIntOrThrow(optionalEnv('MAC_CLICKS', '1'), 'MAC_CLICKS');

  if (!VALID_BUTTONS.has(button)) {
    exitWithError(`Invalid MAC_BUTTON: '${button}'. Must be one of: ${[...VALID_BUTTONS].join(', ')}`);
  }

  let cliclickCmd = '';
  switch (button) {
    case 'right':
      cliclickCmd = `rc:${x},${y}`;
      break;
    case 'center':
      cliclickCmd = `mc:${x},${y}`;
      break;
    default:
      cliclickCmd = `c:${x},${y}`;
  }

  // Handle double-click via repeated clicks
  const args: string[] = [];
  for (let i = 0; i < clicks; i++) {
    args.push(cliclickCmd);
  }

  await runCommand('cliclick', args);

  exitWithResult({ x, y, button, clicks });
}

/**
 * Move mouse to coordinates using cliclick.
 */
async function opMove(): Promise<void> {
  const x = parseIntOrThrow(requireEnv('MAC_X'), 'MAC_X');
  const y = parseIntOrThrow(requireEnv('MAC_Y'), 'MAC_Y');

  await runCommand('cliclick', [`m:${x},${y}`]);

  exitWithResult({ x, y });
}

/**
 * Drag from one point to another using cliclick.
 */
async function opDrag(): Promise<void> {
  const x1 = parseIntOrThrow(requireEnv('MAC_X'), 'MAC_X');
  const y1 = parseIntOrThrow(requireEnv('MAC_Y'), 'MAC_Y');
  const x2 = parseIntOrThrow(requireEnv('MAC_X2'), 'MAC_X2');
  const y2 = parseIntOrThrow(requireEnv('MAC_Y2'), 'MAC_Y2');

  // cliclick dd:x,y = mouse down; du:x,y = mouse up; m:x,y = move
  await runCommand('cliclick', [`dd:${x1},${y1}`, `m:${x2},${y2}`, `du:${x2},${y2}`]);

  exitWithResult({ from: { x: x1, y: y1 }, to: { x: x2, y: y2 } });
}

/**
 * Type text using clipboard method (supports CJK, emoji, etc.)
 * or osascript keystroke method (ASCII only).
 */
async function opType(): Promise<void> {
  const text = requireEnv('MAC_TEXT');
  const mode = optionalEnv('MAC_TYPE_MODE', 'clipboard');

  if (!VALID_TYPE_MODES.has(mode)) {
    exitWithError(`Invalid MAC_TYPE_MODE: '${mode}'. Must be one of: ${[...VALID_TYPE_MODES].join(', ')}`);
  }

  if (mode === 'clipboard') {
    // Save clipboard, paste text, restore clipboard
    const hadContent = await saveClipboard();

    try {
      // Set clipboard content
      const { spawn } = require('node:child_process');
      await new Promise<void>((resolvePromise, reject) => {
        const proc = spawn('pbcopy', [], { timeout: 5000 });
        proc.stdin.write(text);
        proc.stdin.end();
        proc.on('close', (code: number) => {
          if (code === 0) resolvePromise();
          else reject(new Error(`pbcopy exited with code ${code}`));
        });
        proc.on('error', reject);
      });

      // Small delay to ensure clipboard is set
      await new Promise((r) => setTimeout(r, 50));

      // Paste via Cmd+V
      await runCommand('cliclick', ['kd:cmd', 'c:v', 'ku:cmd']);
    } finally {
      // Restore clipboard asynchronously (don't block)
      if (hadContent) {
        restoreClipboard().catch(() => {});
      }
    }
  } else {
    // osascript keystroke method (ASCII only, fails on CJK)
    // Escape double quotes for AppleScript
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await runCommand('osascript', [
      '-e',
      `tell application "System Events" to keystroke "${escaped}"`,
    ]);
  }

  exitWithResult({ text: text.substring(0, 50) + (text.length > 50 ? '...' : ''), mode });
}

/**
 * Press a key with optional modifiers using cliclick.
 */
async function opKey(): Promise<void> {
  const key = requireEnv('MAC_KEY').toLowerCase();
  const modifiersStr = optionalEnv('MAC_MODIFIERS', '');

  // Validate modifiers
  const modifiers = modifiersStr
    ? modifiersStr.split(',').map((m) => m.trim().toLowerCase())
    : [];

  for (const mod of modifiers) {
    if (!VALID_MODIFIERS.has(mod)) {
      exitWithError(`Invalid modifier: '${mod}'. Must be one of: ${[...VALID_MODIFIERS].join(', ')}`);
    }
  }

  // Build cliclick key command
  // cliclick key syntax: kd:cmd,shift k:s ku:cmd,shift
  // For simple keys (single characters), use cliclick
  // For special keys, map via KEY_MAP or use osascript

  const mappedKey = KEY_MAP[key] ?? key;

  // Use osascript for key presses (more reliable for special keys)
  const modifierParts = modifiers.map((m) => {
    switch (m) {
      case 'command': return 'command down';
      case 'shift': return 'shift down';
      case 'control': return 'control down';
      case 'option': return 'option down';
      default: return m;
    }
  });

  const usingModifiers = modifierParts.length > 0;
  const usingSpecialKey = KEY_MAP[key] !== undefined || key.length > 1;

  if (usingSpecialKey || usingModifiers) {
    // Use osascript System Events for key code or special keys
    if (usingModifiers) {
      const keyStr = usingSpecialKey ? `key code ${mappedKey}` : `keystroke "${key}"`;
      await runCommand('osascript', [
        '-e',
        `tell application "System Events" to ${keyStr} using {${modifierParts.join(', ')}}`,
      ]);
    } else {
      // Special key without modifiers - try cliclick for single character keys
      // For special keys, use key code mapping
      const keyCodeMap: Record<string, number> = {
        return: 36,
        tab: 48,
        space: 49,
        delete: 51,
        escape: 53,
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

      if (keyCodeMap[key]) {
        await runCommand('osascript', [
          '-e',
          `tell application "System Events" to key code ${keyCodeMap[key]}`,
        ]);
      } else if (key.length === 1) {
        await runCommand('cliclick', [`kp:${key}`]);
      } else {
        exitWithError(`Unsupported key: '${key}'. Use a single character or a known key name.`);
      }
    }
  } else {
    // Simple single character key
    await runCommand('cliclick', [`kp:${key}`]);
  }

  exitWithResult({ key, modifiers });
}

/**
 * Get window bounds for an application using osascript.
 */
async function opGetWindow(): Promise<void> {
  const appName = requireEnv('MAC_APP');

  const script = `
    tell application "${appName}"
      activate
      set winBounds to bounds of front window
      return winBounds
    end tell
  `;

  let stdout: string;
  try {
    const result = await runCommand('osascript', ['-e', script]);
    stdout = result.stdout;
  } catch {
    // Try with System Events as fallback
    const seScript = `
      tell application "System Events"
        set p to first process whose name is "${appName}"
        set winBounds to position of front window of p & size of front window of p
        return winBounds
      end tell
    `;
    const result = await runCommand('osascript', ['-e', seScript]);
    stdout = result.stdout;
  }

  // Parse bounds: "x, y, x2, y2" or "x, y, width, height"
  const parts = stdout.trim().split(',').map((p) => Number.parseInt(p.trim(), 10));
  if (parts.length < 4 || parts.some((p) => Number.isNaN(p))) {
    exitWithError(`Could not parse window bounds: ${stdout.trim()}`);
  }

  exitWithResult({
    app: appName,
    bounds: {
      x: parts[0],
      y: parts[1],
      width: parts[2] - parts[0] || parts[2],
      height: parts[3] - parts[1] || parts[3],
    },
  });
}

/**
 * Activate (bring to front) an application using osascript.
 */
async function opActivateApp(): Promise<void> {
  const appName = requireEnv('MAC_APP');

  await runCommand('osascript', ['-e', `tell application "${appName}" to activate`]);

  // Small delay for app to come to foreground
  await new Promise((r) => setTimeout(r, 200));

  exitWithResult({ app: appName, activated: true });
}

/**
 * Calibrate display: get scale factor and display info.
 */
async function opCalibrate(): Promise<void> {
  // Get screen size in logical points
  const pointsScript = `
    tell application "Finder"
      set screenBounds to bounds of window of desktop
      return (item 3 of screenBounds) & "," & (item 4 of screenBounds)
    end tell
  `;

  // Get screen size in pixels via system_profiler or screencapture
  let logicalWidth = 0;
  let logicalHeight = 0;

  try {
    const { stdout } = await runCommand('osascript', ['-e', pointsScript]);
    const parts = stdout.trim().split(',').map((p) => Number.parseInt(p.trim(), 10));
    logicalWidth = parts[0];
    logicalHeight = parts[1];
  } catch {
    // Fallback: use system_profiler
    try {
      const { stdout } = await runCommand('system_profiler', [
        'SPDisplaysDataType',
      ]);
      const resolutionMatch = stdout.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
      if (resolutionMatch) {
        // This gives physical pixels
        logicalWidth = Number.parseInt(resolutionMatch[1], 10);
        logicalHeight = Number.parseInt(resolutionMatch[2], 10);
      }
    } catch {
      // Best effort
    }
  }

  // Try to detect Retina by comparing screenshot size to logical size
  let scaleFactor = 1;
  try {
    const testPath = resolve(tmpdir(), 'mac-control-calibrate.png');
    await runCommand('screencapture', ['-x', testPath]);
    // Read the PNG header to get dimensions (first 24 bytes contain IHDR)
    const pngHeader = await readFile(testPath, { encoding: null });
    if (pngHeader.length > 24) {
      // PNG width is at bytes 16-19, height at 20-23 (big endian)
      const pixelWidth = pngHeader.readUInt32BE(16);
      const pixelHeight = pngHeader.readUInt32BE(20);
      if (logicalWidth > 0 && pixelWidth > 0) {
        scaleFactor = Math.round((pixelWidth / logicalWidth) * 10) / 10;
      }
    }
    await unlink(testPath).catch(() => {});
  } catch {
    // Default to 2x for modern Macs
    scaleFactor = 2;
  }

  exitWithResult({
    platform: detectPlatform(),
    scaleFactor,
    logicalResolution: { width: logicalWidth, height: logicalHeight },
    note: 'To convert screenshot pixel coordinates to logical points: divide by scaleFactor',
  });
}

// ---- Main ----

async function main(): Promise<void> {
  const op = requireEnv('MAC_OP');

  if (!VALID_OPS.has(op)) {
    exitWithError(
      `Invalid MAC_OP: '${op}'. Must be one of: ${[...VALID_OPS].join(', ')}`,
    );
  }

  // Platform check
  if (detectPlatform() !== 'macos' && process.env.MAC_SKIP_CHECK !== '1') {
    exitWithError(
      'mac-control only works on macOS. Set MAC_SKIP_CHECK=1 to bypass this check.',
    );
  }

  // Tool availability check (skip in test mode)
  if (process.env.MAC_SKIP_CHECK !== '1') {
    if (op !== 'calibrate' && op !== 'get-window' && op !== 'activate-app') {
      const hasCliclick = await checkToolAvailable('cliclick');
      if (!hasCliclick) {
        exitWithError(
          'cliclick not found. Install via: brew install cliclick',
        );
      }
    }
  }

  // Dispatch to operation handler
  switch (op) {
    case 'screenshot':
      await opScreenshot();
      break;
    case 'click':
      await opClick();
      break;
    case 'move':
      await opMove();
      break;
    case 'drag':
      await opDrag();
      break;
    case 'type':
      await opType();
      break;
    case 'key':
      await opKey();
      break;
    case 'get-window':
      await opGetWindow();
      break;
    case 'activate-app':
      await opActivateApp();
      break;
    case 'calibrate':
      await opCalibrate();
      break;
    default:
      exitWithError(`Unhandled operation: ${op}`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  exitWithError(msg);
});
