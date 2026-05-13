/**
 * ProjectConfigStore — Manages project configurations keyed by projectKey.
 *
 * Implements the ProjectChatIdResolver interface from Phase 1,
 * enabling InputMessageRouter to resolve SystemMessage → chatId.
 *
 * Also provides a CwdProvider factory that resolves chatId → project workingDir
 * via the chatId binding in each ProjectConfig.
 *
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 * @see Issue #3581 (Phase 2: ProjectConfig + AgentPool extension)
 */

import type { CwdProvider, ProjectConfig } from './types.js';
import { createLogger, type Logger } from '../utils/logger.js';

const defaultLogger = createLogger('ProjectConfigStore');

// ============================================================================
// ProjectConfigStore
// ============================================================================

/**
 * Manages a collection of ProjectConfig entries.
 *
 * Primary responsibilities:
 * 1. Store and retrieve ProjectConfig by projectKey
 * 2. Resolve projectKey → chatId (ProjectChatIdResolver)
 * 3. Resolve chatId → workingDir (via CwdProvider factory)
 */
export class ProjectConfigStore {
  private readonly configs = new Map<string, ProjectConfig>();
  private readonly log: Logger;

  constructor(logger?: Logger) {
    this.log = logger ?? defaultLogger;
  }

  // ───────────────────────────────────────────
  // CRUD Operations
  // ───────────────────────────────────────────

  /**
   * Register a project configuration.
   *
   * If a config with the same key already exists, it is replaced.
   *
   * @param config - The project configuration to register
   */
  register(config: ProjectConfig): void {
    const existing = this.configs.get(config.key);
    this.configs.set(config.key, config);
    if (existing) {
      this.log.debug({ key: config.key }, 'Updated existing ProjectConfig');
    } else {
      this.log.debug({ key: config.key }, 'Registered new ProjectConfig');
    }
  }

  /**
   * Remove a project configuration by key.
   *
   * @param key - The project key to remove
   * @returns true if the config was removed, false if not found
   */
  unregister(key: string): boolean {
    return this.configs.delete(key);
  }

  /**
   * Get a project configuration by key.
   *
   * @param key - The project key
   * @returns The ProjectConfig, or undefined if not found
   */
  get(key: string): ProjectConfig | undefined {
    return this.configs.get(key);
  }

  /**
   * Check if a project configuration exists for the given key.
   */
  has(key: string): boolean {
    return this.configs.has(key);
  }

  /**
   * List all registered project configurations.
   */
  list(): ProjectConfig[] {
    return Array.from(this.configs.values());
  }

  // ───────────────────────────────────────────
  // ProjectChatIdResolver Implementation
  // ───────────────────────────────────────────

  /**
   * Resolve a projectKey to its bound chatId.
   *
   * Implements the ProjectChatIdResolver interface from Phase 1,
   * used by InputMessageRouter to route SystemMessages.
   *
   * @param projectKey - Project identifier (e.g. 'hs3180/disclaude')
   * @returns The bound chatId, or undefined if the project is not configured
   */
  resolve(projectKey: string): string | undefined {
    return this.configs.get(projectKey)?.chatId;
  }

  // ───────────────────────────────────────────
  // CwdProvider Factory
  // ───────────────────────────────────────────

  /**
   * Create a CwdProvider that resolves chatId → project workingDir.
   *
   * Looks up the chatId across all registered ProjectConfigs.
   * Returns the workingDir of the first matching config.
   *
   * @returns CwdProvider function for Agent injection
   */
  createCwdProvider(): CwdProvider {
    return (chatId: string): string | undefined => {
      for (const config of this.configs.values()) {
        if (config.chatId === chatId) {
          return config.workingDir;
        }
      }
      return undefined;
    };
  }

  // ───────────────────────────────────────────
  // Lookup Helpers
  // ───────────────────────────────────────────

  /**
   * Find a ProjectConfig by its bound chatId.
   *
   * @param chatId - The chat identifier
   * @returns The ProjectConfig bound to this chatId, or undefined
   */
  getByChatId(chatId: string): ProjectConfig | undefined {
    for (const config of this.configs.values()) {
      if (config.chatId === chatId) {
        return config;
      }
    }
    return undefined;
  }

  /**
   * Get the number of registered projects.
   */
  size(): number {
    return this.configs.size;
  }
}
