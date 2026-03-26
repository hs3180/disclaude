/**
 * SOUL.md type definitions for Agent personality injection.
 *
 * Issue #1315: SOUL.md - Agent personality/behavior definition system.
 *
 * @module soul/types
 */

/**
 * Configuration for the SOUL.md personality system.
 *
 * When configured, the SOUL.md file content is loaded at startup
 * and injected into the Agent's system prompt via `appendSystemPrompt`.
 *
 * @example disclaude.config.yaml
 * ```yaml
 * soul:
 *   path: ~/.disclaude/SOUL.md
 *   maxSize: 32768
 * ```
 */
export interface SoulConfig {
  /**
   * Path to the SOUL.md file.
   * Supports tilde expansion (~ → home directory).
   * Relative paths are resolved against the workspace directory.
   */
  path?: string;

  /**
   * Maximum file size in bytes (default: 32768 = 32KB).
   * Files exceeding this limit will be rejected to prevent token waste.
   */
  maxSize?: number;
}

/**
 * Result of loading a SOUL.md file.
 */
export interface SoulLoadResult {
  /** The loaded SOUL.md content */
  content: string;
  /** The resolved absolute path of the file */
  resolvedPath: string;
  /** File size in bytes */
  sizeBytes: number;
}

/**
 * Error thrown when SOUL.md loading fails.
 */
export class SoulLoadError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'TOO_LARGE' | 'READ_ERROR' | 'INVALID_PATH',
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'SoulLoadError';
  }
}
