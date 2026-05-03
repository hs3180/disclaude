#!/usr/bin/env tsx
/**
 * skills/chat/dissolve-chat.ts — Dissolve a Feishu group chat via lark-cli.
 *
 * Dissolves a Feishu group chat using lark-cli raw API call
 * and removes its record from ChatStore.
 *
 * Uses lark-cli direct API call — NOT through IPC Channel.
 *
 * Environment variables:
 *   DISSOLVE_CHAT_ID  Feishu group chat ID to dissolve (oc_xxx format, required)
 *   DISSOLVE_SKIP_LARK Set to '1' to skip lark-cli check and API call (for testing)
 *
 * Output (stdout, JSON):
 *   { "ok": true, "chatId": "oc_xxx" }
 *   { "ok": false, "error": "..." }
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;

/** Regex for Feishu group chat IDs. */
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

// ---- Helpers ----

function exit(msg: string): never {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

function validateChatId(chatId: string): void {
  if (!chatId) {
    exit('DISSOLVE_CHAT_ID environment variable is required');
  }
  if (!GROUP_CHAT_ID_REGEX.test(chatId)) {
    exit(`Invalid DISSOLVE_CHAT_ID '${chatId}' — must match oc_xxxxx format`);
  }
}

// ---- Core logic ----

/**
 * Dissolve a Feishu group via lark-cli raw API call.
 * Uses: lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
 */
async function dissolveChat(
  chatId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`, '--as', 'bot'],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return { ok: true };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: false, error: errorMsg };
  }
}

/**
 * Remove a temporary chat record from ChatStore.
 * Deletes workspace/schedules/.temp-chats/{chatId}.json
 */
async function removeTempChat(chatId: string): Promise<void> {
  const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join('workspace', 'schedules', '.temp-chats', `${safeId}.json`);

  try {
    await fs.unlink(filePath);
  } catch (error) {
    // File might not exist — that's OK
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Log but don't fail — group dissolution is the primary operation
      console.error(`WARN: Failed to remove ChatStore record: ${error}`);
    }
  }
}

// ---- Main ----

async function main() {
  const chatId = process.env.DISSOLVE_CHAT_ID ?? '';
  const skipLark = process.env.DISSOLVE_SKIP_LARK === '1';

  // Validate inputs
  validateChatId(chatId);

  // Dry-run mode
  if (skipLark) {
    await removeTempChat(chatId);
    console.log(JSON.stringify({ ok: true, chatId }));
    return;
  }

  // Check lark-cli availability
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
  } catch {
    exit('Missing required dependency: lark-cli not found in PATH');
  }

  // Dissolve group
  const result = await dissolveChat(chatId);

  if (!result.ok) {
    console.log(JSON.stringify(result));
    process.exit(1);
  }

  // Clean up ChatStore record
  await removeTempChat(chatId);

  console.log(JSON.stringify({ ok: true, chatId }));
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
