/**
 * SubagentManager - Unified interface for spawning and managing subagents.
 *
 * Issue #997: Unifies subagent creation across:
 * - Schedule Task agents
 * - Task agents
 *
 * Issue #1501: Simplified - 'skill' type removed (skills now handled via
 * ChatAgent.executeOnce() or .md-defined subagents in .claude/agents/).
 * - Unified spawn API with consistent options
 * - Lifecycle management (start, stop, status)
 * - Optional worktree isolation
 * - Progress callbacks
 * - Timeout support
 *
 * Issue #2345 Phase 4: Split into subagent-manager.ts (class + dispatch),
 * subagent-manager-types.ts (type definitions), and
 * subagent-manager-lifecycle.ts (execution, termination, cleanup).
 *
 * Architecture:
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    SubagentManager                          │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                             │
 * │   spawn(options) ──► SubagentHandle                        │
 * │        │                    │                               │
 * │        ▼                    ▼                               │
 * │   ┌─────────┐   ┌────────────────────────────────────┐     │
 * │   │ Process │   │         SubagentType               │     │
 * │   │ Manager │   │  ┌─────────┐         ┌───────┐     │     │
 * │   └─────────┘   │  │schedule │         │ task  │     │     │
 * │                 │  └─────────┘         └───────┘     │     │
 * │                 └────────────────────────────────────┘     │
 * │                                                             │
 * │   list() ──► SubagentHandle[]                              │
 * │   terminate(id) ──► void                                   │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * @module agents/subagent-manager
 */

import { randomUUID } from 'crypto';
import { createLogger } from '@disclaude/core';
import { executeSubagent, terminateSubagent, cleanupOldHandles } from './subagent-manager-lifecycle.js';
import type {
  SubagentOptions,
  SubagentHandle,
  SubagentStatus,
  SubagentStatusCallback,
  SubagentContext,
} from './subagent-manager-types.js';

const logger = createLogger('SubagentManager');

// ============================================================================
// SubagentManager Implementation
// ============================================================================

/**
 * Manager for spawning and tracking subagents.
 *
 * Provides a unified interface for creating subagents of different types:
 * - **schedule**: For scheduled task execution (uses AgentFactory.createAgent)
 * - **task**: For one-time task execution (uses AgentFactory.createAgent)
 *
 * Issue #1501: 'skill' type removed from this manager.
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager();
 *
 * // Spawn a task agent
 * const handle = await manager.spawn({
 *   type: 'task',
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
  private inMemoryAgents: Map<string, import('@disclaude/core').ChatAgent> = new Map();
  private statusCallbacks: Set<SubagentStatusCallback> = new Set();

  /**
   * Get the internal context for lifecycle functions.
   */
  private getCtx(): SubagentContext {
    return {
      handles: this.handles,
      processes: this.processes,
      inMemoryAgents: this.inMemoryAgents,
      notifyStatusChange: this.notifyStatusChange.bind(this),
    };
  }

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
    const subagentId = `${options.type}-${randomUUID().slice(0, 8)}`;

    // Create handle
    const handle: SubagentHandle = {
      id: subagentId,
      type: options.type,
      name: options.name,
      chatId: options.chatId,
      status: 'starting',
      startedAt: new Date(),
      schedule: options.schedule,
      isolation: options.isolation || 'none',
    };

    this.handles.set(subagentId, handle);

    try {
      await executeSubagent(subagentId, options, this.getCtx());
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
   * Terminate a running subagent.
   *
   * @param subagentId - ID of subagent to terminate
   * @returns True if terminated, false if not found
   */
  terminate(subagentId: string): boolean {
    return terminateSubagent(subagentId, this.getCtx());
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
    cleanupOldHandles(this.handles, maxAge);
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
