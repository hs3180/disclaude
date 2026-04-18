/**
 * Keyboard control via macOS clipboard + AppleScript.
 *
 * For non-ASCII text (Chinese, Japanese, emoji), uses the clipboard approach:
 *   pbcopy + Cmd+V
 * This is the most reliable method for CJK input (per m13v's recommendation).
 *
 * For ASCII text and key combinations, uses osascript keystroke/key code.
 *
 * Issue #2216: Keyboard automation with CJK text support.
 *
 * @module mac-control/keyboard
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TypeOptions, ModifierKey } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * execFileAsync wrapper that supports `input` option (stdin data).
 * The promisified version loses the `input` type from ExecFileOptions,
 * so we cast through `spawn`-style options.
 */
function execWithInput(file: string, args: string[], options: { input: string; timeout?: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: options.timeout }, (err) => {
      if (err) {reject(err);}
      else {resolve();}
    });
    child.stdin?.write(options.input);
    child.stdin?.end();
  });
}

/**
 * Check if a string contains non-ASCII characters (CJK, emoji, etc.).
 */
function hasNonAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      return true;
    }
  }
  return false;
}

/**
 * Type text at the current cursor position.
 *
 * Strategy:
 * - Non-ASCII text (Chinese, etc.) → clipboard paste (pbcopy + Cmd+V)
 * - ASCII text → osascript keystroke
 * - Override with `useClipboard: false` to force keystroke mode
 *
 * @param text - Text to type
 * @param options - Typing options
 */
export async function typeText(text: string, options?: TypeOptions): Promise<void> {
  if (!text) {return;}

  const useClipboard = options?.useClipboard ?? true;

  if (useClipboard && hasNonAscii(text)) {
    await typeViaClipboard(text);
  } else {
    await typeViaKeystroke(text, options?.interval);
  }
}

/**
 * Press a key with optional modifiers.
 *
 * Uses AppleScript `key code` for special keys and `keystroke` for
 * regular characters.
 *
 * @param key - Key name (e.g. 'return', 'tab', 'v', 'a')
 * @param modifiers - Modifier keys (e.g. ['cmd'])
 *
 * @example
 * ```ts
 * // Cmd+V (paste)
 * await pressKey('v', ['cmd']);
 * // Cmd+A (select all)
 * await pressKey('a', ['cmd']);
 * // Return key
 * await pressKey('return');
 * ```
 */
export async function pressKey(key: string, modifiers?: ModifierKey[]): Promise<void> {
  const mods = formatModifiers(modifiers);
  const script = key.match(/^[a-z0-9]$/)
    ? `tell application "System Events" to keystroke "${key}"${mods}`
    : `tell application "System Events" to key code ${toKeyCode(key)}${mods}`;

  await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
}

/**
 * Type text via clipboard paste (pbcopy + Cmd+V).
 *
 * This is the recommended approach for CJK text input because:
 * 1. osascript `keystroke` cannot handle composed characters
 * 2. CGEvent `CGEventKeyboardSetUnicodeString` breaks with CJK sequences
 * 3. The clipboard method handles everything: CJK, emoji, combining marks
 *
 * The original clipboard contents are saved and restored after pasting
 * to be non-destructive.
 */
async function typeViaClipboard(text: string): Promise<void> {
  // Step 1: Save current clipboard
  let savedClipboard = '';
  try {
    const { stdout } = await execFileAsync('pbpaste', [], { timeout: 3000 });
    savedClipboard = stdout;
  } catch {
    // Clipboard might be empty or contain non-text data
  }

  // Step 2: Copy text to clipboard via stdin
  await execWithInput('pbcopy', [], { input: text, timeout: 3000 });

  // Step 3: Small delay to ensure clipboard is ready
  await new Promise(resolve => setTimeout(resolve, 50));

  // Step 4: Cmd+V to paste
  await pressKey('v', ['cmd']);

  // Step 5: Restore original clipboard (after a short delay)
  setTimeout(async () => {
    try {
      await execWithInput('pbcopy', [], { input: savedClipboard, timeout: 3000 });
    } catch {
      // Ignore restore errors
    }
  }, 200);
}

/**
 * Type ASCII text via osascript keystroke.
 */
async function typeViaKeystroke(text: string, interval?: number): Promise<void> {
  const delay = interval ?? 20;

  // Process character by character for reliability
  for (const char of text) {
    const escaped = char.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "System Events" to keystroke "${escaped}"`;
    await execFileAsync('osascript', ['-e', script], { timeout: 3000 });

    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Format modifier keys for AppleScript.
 */
function formatModifiers(modifiers?: ModifierKey[]): string {
  if (!modifiers || modifiers.length === 0) {return '';}

  const mapped = modifiers.map(m => {
    switch (m) {
      case 'cmd':
      case 'command': return 'command down';
      case 'shift': return 'shift down';
      case 'option':
      case 'alt': return 'option down';
      case 'control':
      case 'ctrl': return 'control down';
      case 'fn': return 'fn down';
      default: return `${m} down`;
    }
  });

  return ` using {${mapped.join(', ')}}`;
}

/**
 * Map key names to macOS key codes.
 *
 * Reference: https://eastmanreference.com/complete-list-of-applescript-key-codes
 */
function toKeyCode(key: string): number {
  const keyCodes: Record<string, number> = {
    'return': 36,
    'enter': 36,
    'tab': 48,
    'space': 49,
    'delete': 51,
    'backspace': 51,
    'escape': 53,
    'esc': 53,
    'left': 123,
    'right': 124,
    'down': 125,
    'up': 126,
    'home': 115,
    'end': 119,
    'pageup': 116,
    'pagedown': 121,
    'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118,
    'f5': 96, 'f6': 97, 'f7': 98, 'f8': 100,
    'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
  };

  const code = keyCodes[key.toLowerCase()];
  if (code === undefined) {
    throw new Error(`Unknown key name: "${key}". Use a single character or a known key name.`);
  }
  return code;
}
