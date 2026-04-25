/**
 * Runtime Context - Dependency injection for platform-specific dependencies.
 *
 * Issue #2345 Phase 4: Extracted from types.ts to keep file under 300 lines.
 *
 * Main package implements AgentRuntimeContext and injects it into core
 * to decouple agents from platform-specific dependencies.
 *
 * @module agents/runtime-context
 */

import type { AgentProvider } from './types.js';

// ============================================================================
// Runtime Context Interface (Issue #1040)
// ============================================================================

/**
 * Runtime context interface for dependency injection.
 *
 * Main package implements this interface and injects it into core
 * to decouple agents from platform-specific dependencies.
 *
 * @example
 * ```typescript
 * // In main package (src/cli-entry.ts)
 * import { setRuntimeContext } from '@disclaude/core';
 *
 * setRuntimeContext({
 *   getWorkspaceDir: () => Config.getWorkspaceDir(),
 *   getAgentConfig: () => Config.getAgentConfig(),
 *   getLoggingConfig: () => Config.getLoggingConfig(),
 *   getGlobalEnv: () => Config.getGlobalEnv(),
 *   isAgentTeamsEnabled: () => Config.isAgentTeamsEnabled(),
 *   createMcpServer: (chatId) => createChannelMcpServer(chatId),
 *   findSkill: (name) => findSkill(name),
 * });
 * ```
 */
export interface AgentRuntimeContext {
  // Config-related methods
  /** Get the workspace directory path */
  getWorkspaceDir(): string;
  /** Get agent configuration (API key, model, provider) */
  getAgentConfig(): { apiKey: string; model: string; apiBaseUrl?: string; provider: AgentProvider };
  /** Get logging configuration */
  getLoggingConfig(): { sdkDebug: boolean };
  /** Get global environment variables */
  getGlobalEnv(): Record<string, string>;
  /** Check if Agent Teams mode is enabled */
  isAgentTeamsEnabled(): boolean;

  // Platform adapters (optional - only needed for ChatAgent)
  /** Create MCP server instance for a chatId */
  createMcpServer?(chatId: string): Promise<unknown>;
  /** Send a text message to a chat */
  sendMessage?(chatId: string, text: string, parentMessageId?: string): Promise<void>;
  /** Send an interactive card to a chat */
  sendCard?(chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string): Promise<void>;
  /** Send a file to a chat */
  sendFile?(chatId: string, filePath: string): Promise<void>;

  // Skill-related methods (optional)
  /** Find a skill by name */
  findSkill?(skillName: string): Promise<string | undefined>;

  // ACP Client (optional - for ACP-based agent execution, Issue #2311)
  /** Get the shared ACP Client instance */
  getAcpClient?(): import('../sdk/acp/acp-client.js').AcpClient;
}

// Global runtime context (set by main package)
let globalRuntimeContext: AgentRuntimeContext | null = null;

/**
 * Set the runtime context for agents.
 * Must be called by main package before using any agents.
 *
 * @param ctx - Runtime context implementation
 */
export function setRuntimeContext(ctx: AgentRuntimeContext): void {
  globalRuntimeContext = ctx;
}

/**
 * Get the runtime context.
 * Throws if context is not set.
 *
 * @returns The runtime context
 * @throws Error if context not set
 */
export function getRuntimeContext(): AgentRuntimeContext {
  if (!globalRuntimeContext) {
    throw new Error('Runtime context not set. Call setRuntimeContext() first.');
  }
  return globalRuntimeContext;
}

/**
 * Check if runtime context is set.
 * Useful for conditional behavior during migration.
 *
 * @returns true if context is set
 */
export function hasRuntimeContext(): boolean {
  return globalRuntimeContext !== null;
}

/**
 * Clear the runtime context (for testing).
 */
export function clearRuntimeContext(): void {
  globalRuntimeContext = null;
}
