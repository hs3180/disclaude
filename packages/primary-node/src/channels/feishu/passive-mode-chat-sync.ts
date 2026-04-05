/**
 * Passive Mode Chat File Sync.
 *
 * Issue #2018: Scans workspace/chats/ for active temporary chats and
 * synchronizes their declarative passive mode settings to PassiveModeManager.
 *
 * This bridges the gap between the script-based chat system (create.ts /
 * chats-activation.ts) and the runtime PassiveModeManager. When a temporary
 * chat is activated (group created), the primary node needs to apply the
 * chat's passive mode setting so the bot responds correctly.
 *
 * The sync runs:
 * 1. Once at startup (immediate)
 * 2. Periodically (every SYNC_INTERVAL_MS) to detect newly activated chats
 *
 * @module channels/feishu/passive-mode-chat-sync
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, Config } from '@disclaude/core';
import type { PassiveModeManager } from './passive-mode.js';

const logger = createLogger('PassiveModeChatSync');

/** How often to scan chat files for newly activated chats (default: 15s) */
const SYNC_INTERVAL_MS = 15_000;

/** Max age of a chat file before skipping sync (default: 7 days) */
const MAX_CHAT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PassiveModeChatSyncOptions {
  /** PassiveModeManager instance to apply settings to */
  passiveModeManager: PassiveModeManager;
  /** Override chat directory path (default: workspace/chats/) */
  chatDir?: string;
  /** Sync interval in ms (default: 15000) */
  intervalMs?: number;
}

/**
 * Tracks which chat IDs have already been synced to avoid redundant log output.
 */
const syncedChatIds = new Set<string>();

/**
 * Scan workspace/chats/ for active temporary chats and sync their
 * passive mode settings to PassiveModeManager.
 *
 * Only chats with `status: 'active'`, a valid `chatId`, and
 * `passiveMode: false` will have passive mode disabled.
 *
 * @param chatDir - Path to the chats directory
 * @param passiveModeManager - PassiveModeManager instance
 * @returns Number of chats that had passive mode newly applied
 */
export function syncPassiveModeFromChatFiles(
  chatDir: string,
  passiveModeManager: PassiveModeManager,
): number {
  let applied = 0;

  let files: string[];
  try {
    files = fs.readdirSync(chatDir);
  } catch {
    // Directory doesn't exist — no chats to sync
    return 0;
  }

  const now = Date.now();

  for (const fileName of files) {
    if (!fileName.endsWith('.json')) continue;

    const filePath = path.join(chatDir, fileName);

    // Read and parse chat file
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    let chat: {
      status?: string;
      chatId?: string | null;
      passiveMode?: boolean;
      createdAt?: string;
    };
    try {
      chat = JSON.parse(content);
    } catch {
      continue;
    }

    // Only sync active chats with a valid chatId
    if (chat.status !== 'active' || !chat.chatId) continue;

    // Skip old chats (expired cleanup should handle these)
    if (chat.createdAt) {
      try {
        const created = new Date(chat.createdAt).getTime();
        if (now - created > MAX_CHAT_AGE_MS) continue;
      } catch {
        // Invalid date format, skip age check
      }
    }

    // Apply passive mode setting
    // passiveMode: false → disable passive mode (bot responds to all)
    // passiveMode: true or undefined → keep default (passive mode enabled)
    if (chat.passiveMode === false) {
      if (!passiveModeManager.isPassiveModeDisabled(chat.chatId)) {
        passiveModeManager.setPassiveModeDisabled(chat.chatId, true);
        applied++;

        // Only log once per chatId to avoid spam
        if (!syncedChatIds.has(chat.chatId)) {
          syncedChatIds.add(chat.chatId);
          logger.info({ chatId: chat.chatId, source: 'chat-file' }, 'Passive mode disabled from chat file sync');
        }
      }
    }
  }

  return applied;
}

/**
 * Start periodic passive mode sync from chat files.
 *
 * @param options - Sync configuration
 * @returns A cleanup function that stops the periodic sync
 */
export function startPassiveModeChatSync(options: PassiveModeChatSyncOptions): () => void {
  const { passiveModeManager, intervalMs = SYNC_INTERVAL_MS } = options;

  // Resolve chat directory
  const chatDir = options.chatDir ?? path.join(Config.getWorkspaceDir(), 'chats');

  // Initial sync
  const initialCount = syncPassiveModeFromChatFiles(chatDir, passiveModeManager);
  if (initialCount > 0) {
    logger.info({ count: initialCount }, 'Initial passive mode sync from chat files');
  }

  // Periodic sync
  const timer = setInterval(() => {
    try {
      const count = syncPassiveModeFromChatFiles(chatDir, passiveModeManager);
      if (count > 0) {
        logger.info({ count }, 'Periodic passive mode sync from chat files');
      }
    } catch (err) {
      logger.error({ err }, 'Error during periodic passive mode chat sync');
    }
  }, intervalMs);

  // Don't prevent process exit
  if (timer.unref) {
    timer.unref();
  }

  // Return cleanup function
  return () => {
    clearInterval(timer);
    syncedChatIds.clear();
  };
}
