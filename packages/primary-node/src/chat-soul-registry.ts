/**
 * ChatSoulRegistry - Per-chat soul content registry.
 *
 * Issue #1228: Discussion focus via SOUL.md personality injection.
 *
 * Stores soul content (loaded from SOUL.md files) per chatId.
 * When a chat is created with a `soul` parameter, the content is loaded
 * and stored here. When an agent is created for that chatId, the soul
 * content is retrieved and injected as systemPromptAppend.
 *
 * @module primary-node/chat-soul-registry
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '@disclaude/core';

const logger = createLogger('ChatSoulRegistry');

/**
 * Soul loading result.
 */
export interface SoulLoadResult {
  /** Loaded soul content */
  content: string;
  /** Resolved absolute path */
  resolvedPath: string;
  /** File size in bytes */
  sizeBytes: number;
}

/**
 * Registry for per-chat soul content.
 *
 * Usage:
 * 1. When create_chat is called with a soul parameter, load and register the soul.
 * 2. When an agent is created for a chatId, retrieve the soul content.
 * 3. When a chat is dissolved, unregister the soul.
 */
export class ChatSoulRegistry {
  private readonly soulContentMap = new Map<string, string>();
  private readonly builtinSoulsDir?: string;

  constructor(builtinSoulsDir?: string) {
    this.builtinSoulsDir = builtinSoulsDir;
  }

  /**
   * Load and register a soul profile for a chatId.
   *
   * @param chatId - Chat ID to associate soul with
   * @param soul - Soul parameter (built-in name, absolute path, relative path, or tilde path)
   * @param workspaceDir - Workspace directory for resolving relative paths
   * @throws Error if soul file cannot be loaded
   */
  async registerSoul(chatId: string, soul: string, workspaceDir?: string): Promise<SoulLoadResult> {
    const resolvedPath = this.resolveSoulPath(soul, workspaceDir);

    // Load the soul file content
    const content = await this.loadSoulFile(resolvedPath);

    // Store the content
    this.soulContentMap.set(chatId, content);

    logger.info(
      { chatId, soul, resolvedPath, sizeBytes: Buffer.byteLength(content, 'utf-8') },
      'Soul profile registered for chat'
    );

    return {
      content,
      resolvedPath,
      sizeBytes: Buffer.byteLength(content, 'utf-8'),
    };
  }

  /**
   * Get the soul content for a chatId.
   *
   * @param chatId - Chat ID
   * @returns Soul content or undefined if not registered
   */
  getSoulContent(chatId: string): string | undefined {
    return this.soulContentMap.get(chatId);
  }

  /**
   * Check if a chatId has a registered soul.
   *
   * @param chatId - Chat ID
   * @returns true if soul is registered
   */
  hasSoul(chatId: string): boolean {
    return this.soulContentMap.has(chatId);
  }

  /**
   * Unregister soul for a chatId (e.g., when chat is dissolved).
   *
   * @param chatId - Chat ID
   */
  unregisterSoul(chatId: string): void {
    this.soulContentMap.delete(chatId);
    logger.info({ chatId }, 'Soul profile unregistered for chat');
  }

  /**
   * Clear all registered souls.
   */
  clear(): void {
    this.soulContentMap.clear();
  }

  /**
   * Resolve a soul parameter to an absolute file path.
   *
   * Supports:
   * - Built-in profile names: "discussion"
   * - Absolute paths: used as-is
   * - Tilde paths: expanded to home directory
   * - Relative paths: resolved against workspace directory
   */
  resolveSoulPath(soul: string, workspaceDir?: string): string {
    // Built-in profile: "discussion"
    if (soul === 'discussion') {
      if (this.builtinSoulsDir) {
        return path.join(this.builtinSoulsDir, 'discussion.md');
      }
      throw new Error(`Built-in soul "${soul}" requested but builtinSoulsDir not configured`);
    }

    // Tilde expansion
    if (soul.startsWith('~')) {
      return path.join(os.homedir(), soul.slice(1));
    }

    // Absolute path
    if (path.isAbsolute(soul)) {
      return soul;
    }

    // Relative path: resolve against workspace
    if (workspaceDir) {
      return path.resolve(workspaceDir, soul);
    }

    return path.resolve(soul);
  }

  /**
   * Load a soul file with safety checks.
   *
   * @param filePath - Absolute path to soul file
   * @returns File content (trimmed)
   * @throws Error if file cannot be read
   */
  private async loadSoulFile(filePath: string): Promise<string> {
    const MAX_SOUL_SIZE = 32 * 1024; // 32KB

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_SOUL_SIZE) {
        throw new Error(`Soul file too large: ${stat.size} bytes (max: ${MAX_SOUL_SIZE} bytes)`);
      }

      const content = await fs.promises.readFile(filePath, 'utf-8');
      return content.trim();
    } catch (err) {
      if (err instanceof Error && err.message.includes('too large')) {
        throw err;
      }
      throw new Error(`Failed to load soul file: ${filePath} - ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
