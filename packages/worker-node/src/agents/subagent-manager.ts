/**
 * SubagentManager - Unified interface for spawning and managing subagents.
 *
 * Issue #997: Unifies subagent creation across all agent use cases.
 * Issue #1501: Simplified - 'skill' type removed (skills now handled via
 * ChatAgent.executeOnce() or .md-defined subagents in .claude/agents/).
 * Issue #2513: Removed ScheduleAgent/TaskAgent type distinction.
 * All agents are created identically via AgentFactory.createAgent().
 *
 * Features:
 * - Unified spawn API with consistent options
 * - Lifecycle management (start, stop, status)
 * - Optional worktree isolation
 * - Progress callbacks
 * - Timeout support
 *
 * Architecture:
 * ```
 * ┌──────────────────────────────────────────────────────────┐
 * │                    SubagentManager                        │
 * ├──────────────────────────────────────────────────────────┤
 * │                                                          │
 * │   spawn(options) ──► SubagentHandle                      │
 * │        │                                                 │
 * │        ▼                                                 │
 * │   ┌─────────┐   ┌──────────────────────────────────┐    │
 * │   │ Process │   │  AgentFactory.createAgent()       │    │
 * │   │ Manager │   │  (single unified agent type)       │    │
 * │   └─────────┘   └──────────────────────────────────┘    │
 * │                                                          │
 * │   list() ──► SubagentHandle[]                            │
 * │   terminate(id) ──► void                                 │
 * │                                                          │
 * └──────────────────────────────────────────────────────────┘
 * ```
 *
 * @module agents/subagent-manager
 */

import { randomUUID } from 'crypto';
import { createLogger, type ChatAgent } from '@disclaude/core';
import { AgentFactory } from './factory.js';
import type { ChatAgentCallbacks } from './chat-agent/index.js';

const logger = createLogger('SubagentManager');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Isolation mode for subagent execution.
 */
export type IsolationMode = 'worktree' | 'none';

/**
 * Status of a subagent.
 */
export type SubagentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Options for spawning a subagent.
 *
 * @example
 * ```typescript
 * const options: SubagentOptions = {
 *   name: 'issue-solver',
 *   prompt: 'Fix issue #123',
 *   chatId: 'chat-123',
 *   callbacks: {
 *     sendMessage: async (chatId, text) => { ... },
 *   },
 *   timeout: 60000,
 *   isolation: 'none',
 * };
 * ```
 */
export interface SubagentOptions {
  /** Name/identifier for the subagent */
  name: string;
  /** Prompt/task for the subagent to execute */
  prompt: string;
  /** Chat ID for message delivery */
  chatId: string;
  /** Callbacks for sending messages */
  callbacks: ChatAgentCallbacks;
  /** Optional cron expression for scheduled execution context */
  schedule?: string;
  /** Optional timeout in milliseconds */
  timeout?: number;
  /** Isolation mode (default: 'none') */
  isolation?: IsolationMode;
  /** Optional progress callback */
  onProgress?: (message: string) => void;
  /** Optional sender OpenId */
  senderOpenId?: string;
}

/**
 * Handle to a spawned subagent.
 *
 * Provides status tracking and control over the subagent lifecycle.
 */
export interface SubagentHandle {
  /** Unique subagent ID */
  id: string;
  /** Subagent name */
  name: string;
  /** Target chat ID */
  chatId: string;
  /** Current status */
  status: SubagentStatus;
  /** Process ID (if running in separate process) */
  pid?: number;
  /** Start time */
  startedAt: Date;
  /** Completion time (if completed) */
  completedAt?: Date;
  /** Error message (if failed) */
  error?: string;
  /** Output from the subagent */
  output?: string;
  /** Cron schedule (if scheduled) */
  schedule?: string;
  /** Isolation mode used */
  isolation: IsolationMode;
}

/**
 * Callback for subagent status changes.
 */
export type SubagentStatusCallback = (handle: SubagentHandle) => void;

// ============================================================================
// SubagentManager Implementation
// ============================================================================

/**
 * Manager for spawning and tracking subagents.
 *
 * Provides a unified interface for creating subagents.
 * All agents are created identically via AgentFactory.createAgent().
 *
 * Issue #1501: 'skill' type removed from this manager.
 * Issue #2513: ScheduleAgent/TaskAgent type distinction removed.
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager();
 *
 * // Spawn a subagent
 * const handle = await manager.spawn({
 *   name: 'issue-solver',
 *   prompt: 'Fix issue #123',
 *   chatId: 'chat-123',
 *   callbacks: {
 *     sendMessage: async (chatId, text) => { ... },
 *   },
 * });
 *
 * // List running subagents
 * const running = manager.list('running');
 *
 * // Terminate a subagent
 * await manager.terminate(handle.id);
 * ```
 */
export class SubagentManager {
  private handles: Map<string, SubagentHandle> = new Map();
  private processes: Map<string, import('child_process').ChildProcess> = new Map();
  private inMemoryAgents: Map<string, ChatAgent> = new Map();
  private statusCallbacks: Set<SubagentStatusCallback> = new Set();

  /**
   * Register a callback for status changes.
   *
   * @param callback - Function to call when status changes
   * @returns Unsubscribe function
   */
  onStatusChange(callback: SubagentStatusCallback): () => void {
    this.statusCallbacks.add(callback);
    return () => this.statusCallbacks.delete(callback);
  }

  /**
   * Notify all registered callbacks of a status change.
   */
  private notifyStatusChange(handle: SubagentHandle): void {
    for (const callback of this.statusCallbacks) {
      try {
        callback(handle);
      } catch (error) {
        logger.error({ err: error, subagentId: handle.id }, 'Error in status callback');
      }
    }
  }

  /**
   * Spawn a subagent.
   *
   * @param options - Subagent options
   * @returns Handle to the spawned subagent
   */
  async spawn(options: SubagentOptions): Promise<SubagentHandle> {
    const subagentId = `agent-${randomUUID().slice(0, 8)}`;

    // Create handle
    const handle: SubagentHandle = {
      id: subagentId,
      name: options.name,
      chatId: options.chatId,
      status: 'starting',
      startedAt: new Date(),
      schedule: options.schedule,
      isolation: options.isolation || 'none',
    };

    this.handles.set(subagentId, handle);

    try {
      await this.spawnAgent(subagentId, options);
    } catch (error) {
      handle.status = 'failed';
      handle.error = error instanceof Error ? error.message : String(error);
      handle.completedAt = new Date();
      this.notifyStatusChange(handle);
      throw error;
    }

    return handle;
  }

  /**
   * Spawn an agent in memory.
   */
  private async spawnAgent(
    subagentId: string,
    options: SubagentOptions
  ): Promise<void> {
    const handle = this.handles.get(subagentId);
    if (!handle) {
      throw new Error(`Subagent handle not found: ${subagentId}`);
    }

    // Create agent using factory
    const agent = AgentFactory.createAgent(
      options.chatId,
      options.callbacks
    );

    this.inMemoryAgents.set(subagentId, agent);
    handle.status = 'running';

    logger.info({ subagentId, name: options.name }, 'Subagent started');
    this.notifyStatusChange(handle);

    // Execute task
    try {
      await agent.executeOnce(
        options.chatId,
        options.prompt,
        undefined,
        options.senderOpenId
      );

      handle.status = 'completed';
      handle.completedAt = new Date();
      logger.info({ subagentId }, 'Subagent completed');
    } catch (error) {
      handle.status = 'failed';
      handle.error = error instanceof Error ? error.message : String(error);
      handle.completedAt = new Date();
      logger.error({ err: error, subagentId }, 'Subagent failed');
    }

    this.notifyStatusChange(handle);

    // Cleanup
    try {
      agent.dispose();
    } catch (err) {
      logger.error({ err, subagentId }, 'Error disposing agent');
    }
    this.inMemoryAgents.delete(subagentId);
  }

  /**
   * Terminate a running subagent.
   *
   * @param subagentId - ID of subagent to terminate
   * @returns True if terminated, false if not found
   */
  terminate(subagentId: string): boolean {
    const handle = this.handles.get(subagentId);
    if (!handle) {
      return false;
    }

    // Terminate child process if any
    const childProcess = this.processes.get(subagentId);
    if (childProcess) {
      childProcess.kill('SIGTERM');
      this.processes.delete(subagentId);
    }

    // Dispose in-memory agent if any
    const agent = this.inMemoryAgents.get(subagentId);
    if (agent) {
      try {
        agent.dispose();
      } catch (err) {
        logger.error({ err, subagentId }, 'Error disposing agent during termination');
      }
      this.inMemoryAgents.delete(subagentId);
    }

    handle.status = 'stopped';
    handle.completedAt = new Date();
    this.notifyStatusChange(handle);

    logger.info({ subagentId }, 'Subagent terminated');
    return true;
  }

  /**
   * Get information about a specific subagent.
   *
   * @param subagentId - Subagent ID
   * @returns Subagent handle or undefined
   */
  get(subagentId: string): SubagentHandle | undefined {
    return this.handles.get(subagentId);
  }

  /**
   * Get status of a specific subagent.
   *
   * @param subagentId - Subagent ID
   * @returns Status or undefined
   */
  getStatus(subagentId: string): SubagentStatus | undefined {
    return this.handles.get(subagentId)?.status;
  }

  /**
   * List all subagents, optionally filtered by status.
   *
   * @param status - Optional status filter
   * @returns Array of subagent handles
   */
  list(status?: SubagentStatus): SubagentHandle[] {
    const allHandles = Array.from(this.handles.values());

    if (status) {
      return allHandles.filter(h => h.status === status);
    }

    return allHandles;
  }

  /**
   * List running subagents.
   *
   * @returns Array of running subagent handles
   */
  listRunning(): SubagentHandle[] {
    return this.list('running');
  }

  /**
   * Terminate all running subagents.
   */
  terminateAll(): void {
    const runningHandles = this.listRunning();

    for (const handle of runningHandles) {
      this.terminate(handle.id);
    }

    logger.info({ count: runningHandles.length }, 'All subagents terminated');
  }

  /**
   * Clean up completed/failed subagents from memory.
   *
   * @param maxAge - Maximum age in milliseconds (default: 1 hour)
   */
  cleanup(maxAge: number = 3600000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, handle] of this.handles) {
      if (
        (handle.status === 'completed' || handle.status === 'failed' || handle.status === 'stopped') &&
        handle.completedAt &&
        now - handle.completedAt.getTime() > maxAge
      ) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.handles.delete(id);
    }

    if (toDelete.length > 0) {
      logger.debug({ count: toDelete.length }, 'Cleaned up old subagent records');
    }
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    this.terminateAll();
    this.handles.clear();
    this.statusCallbacks.clear();
  }
}

// ============================================================================
// Global Singleton
// ============================================================================

let globalManager: SubagentManager | undefined;

/**
 * Get the global SubagentManager instance.
 */
export function getSubagentManager(): SubagentManager | undefined {
  return globalManager;
}

/**
 * Initialize the global SubagentManager.
 */
export function initSubagentManager(): SubagentManager {
  globalManager = new SubagentManager();
  return globalManager;
}

/**
 * Reset the global manager (for testing).
 */
export function resetSubagentManager(): void {
  if (globalManager) {
    void globalManager.dispose();
  }
  globalManager = undefined;
}
