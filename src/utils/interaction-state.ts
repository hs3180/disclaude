/**
 * Interaction State Storage - Cross-process shared storage for interactive message contexts.
 *
 * Solves the cross-process state isolation problem where:
 * - MCP process registers action prompts when sending interactive messages
 * - Bot main process needs to access these prompts when handling card actions
 *
 * Uses file-based storage to share state between processes.
 *
 * @see Issue #894 - 飞书卡片按钮点击无响应
 * @module utils/interaction-state
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger.js';
import type { ActionPromptMap, InteractiveMessageContext } from '../mcp/tools/types.js';

const logger = createLogger('InteractionState');

/**
 * Storage format for interaction contexts.
 */
interface InteractionStorage {
  /** Version for future migrations */
  version: number;
  /** Contexts indexed by messageId */
  contexts: Record<string, InteractiveMessageContext>;
}

/**
 * Interaction state configuration.
 */
export interface InteractionStateConfig {
  /** Storage file path (default: workspace/.state/interactions.json) */
  filePath?: string;
}

/**
 * Default storage file path.
 */
const DEFAULT_FILE_PATH = path.join(process.cwd(), 'workspace', '.state', 'interactions.json');

/**
 * In-memory cache for performance.
 * Falls back to file storage on cache miss.
 */
let memoryCache: Map<string, InteractiveMessageContext> | null = null;
let storageFilePath: string = DEFAULT_FILE_PATH;

/**
 * Get or initialize the memory cache.
 */
function getCache(): Map<string, InteractiveMessageContext> {
  if (!memoryCache) {
    initInteractionState();
  }
  return memoryCache as Map<string, InteractiveMessageContext>;
}

/**
 * Initialize the interaction state storage.
 * Should be called once at application startup.
 */
export function initInteractionState(config: InteractionStateConfig = {}): void {
  storageFilePath = config.filePath || DEFAULT_FILE_PATH;
  const cache = new Map<string, InteractiveMessageContext>();
  memoryCache = cache;

  // Pre-load existing contexts into memory cache
  const storage = loadFromFile();
  for (const [messageId, context] of Object.entries(storage.contexts)) {
    cache.set(messageId, context);
  }

  logger.info(
    { filePath: storageFilePath, contextCount: cache.size },
    'Interaction state initialized'
  );
}

/**
 * Load storage from file.
 */
function loadFromFile(): InteractionStorage {
  try {
    if (fs.existsSync(storageFilePath)) {
      const content = fs.readFileSync(storageFilePath, 'utf-8');
      const data = JSON.parse(content) as InteractionStorage;
      logger.debug({ contextCount: Object.keys(data.contexts || {}).length }, 'Interaction storage loaded from file');
      return data;
    }
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load interaction storage, starting fresh');
  }
  return { version: 1, contexts: {} };
}

/**
 * Save storage to file.
 */
function saveToFile(): void {
  try {
    const dir = path.dirname(storageFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const cache = getCache();
    const storage: InteractionStorage = {
      version: 1,
      contexts: Object.fromEntries(cache),
    };

    fs.writeFileSync(storageFilePath, JSON.stringify(storage, null, 2));
    logger.debug({ contextCount: Object.keys(storage.contexts).length }, 'Interaction storage saved to file');
  } catch (error) {
    logger.error({ err: error }, 'Failed to save interaction storage');
  }
}

/**
 * Register action prompts for a message.
 * Stores in both memory cache and file for cross-process access.
 *
 * @param messageId - The message ID
 * @param chatId - The chat ID
 * @param actionPrompts - Map of action values to prompt templates
 */
export function registerInteractionContext(
  messageId: string,
  chatId: string,
  actionPrompts: ActionPromptMap
): void {
  const cache = getCache();

  const context: InteractiveMessageContext = {
    messageId,
    chatId,
    actionPrompts,
    createdAt: Date.now(),
  };

  cache.set(messageId, context);
  saveToFile();

  logger.debug({ messageId, chatId, actions: Object.keys(actionPrompts) }, 'Interaction context registered');
}

/**
 * Get action prompts for a message.
 * Checks memory cache first, then falls back to file storage.
 *
 * @param messageId - The message ID
 * @returns The action prompts or undefined if not found
 */
export function getInteractionContext(messageId: string): InteractiveMessageContext | undefined {
  const cache = getCache();

  // Check memory cache first
  let context = cache.get(messageId);

  if (!context) {
    // Fall back to file storage (in case another process wrote it)
    const storage = loadFromFile();
    context = storage.contexts[messageId];

    if (context) {
      // Update memory cache
      cache.set(messageId, context);
      logger.debug({ messageId }, 'Interaction context loaded from file');
    }
  }

  return context;
}

/**
 * Get action prompts for a message.
 * Convenience function that returns just the prompts.
 *
 * @param messageId - The message ID
 * @returns The action prompts or undefined if not found
 */
export function getActionPrompts(messageId: string): ActionPromptMap | undefined {
  const context = getInteractionContext(messageId);
  return context?.actionPrompts;
}

/**
 * Remove interaction context for a message.
 *
 * @param messageId - The message ID
 * @returns Whether the context was removed
 */
export function unregisterInteractionContext(messageId: string): boolean {
  const cache = getCache();
  const removed = cache.delete(messageId);
  if (removed) {
    saveToFile();
    logger.debug({ messageId }, 'Interaction context unregistered');
  }
  return removed;
}

/**
 * Cleanup expired interaction contexts (older than 24 hours).
 *
 * @returns Number of contexts cleaned up
 */
export function cleanupExpiredContexts(): number {
  const cache = getCache();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();
  let cleaned = 0;

  for (const [messageId, context] of cache) {
    if (now - context.createdAt > maxAge) {
      cache.delete(messageId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    saveToFile();
    logger.debug({ count: cleaned }, 'Cleaned up expired interaction contexts');
  }

  return cleaned;
}

/**
 * Get the number of registered contexts (for testing/debugging).
 */
export function getContextCount(): number {
  return getCache().size;
}

/**
 * Clear all contexts (for testing).
 */
export function clearAllContexts(): void {
  const cache = getCache();
  cache.clear();
  saveToFile();
}
