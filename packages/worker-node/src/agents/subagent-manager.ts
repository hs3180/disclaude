/**
 * SubagentManager - Unified interface for spawning and managing subagents.
 *
 * Issue #997: Unifies subagent creation across schedule/task agents.
 * Issue #1501: Simplified - 'skill' type removed.
 * Issue #2345 Phase 4: Types extracted to subagent-types.ts,
 *   spawnScheduleAgent/spawnTaskAgent merged into spawnInMemoryAgent().
 *
 * Architecture:
 *   SubagentManager → spawn(options) → SubagentHandle
 *                    → list/terminate/cleanup for lifecycle management
 *
 * @module agents/subagent-manager
 */

import { randomUUID } from 'crypto';
import { createLogger, type ChatAgent } from '@disclaude/core';
import { AgentFactory } from './factory.js';
import type {
  SubagentStatus,
  SubagentOptions,
  SubagentHandle,
  SubagentStatusCallback,
} from './subagent-types.js';

// Re-export types for backward compatibility
export type {
  SubagentType,
  IsolationMode,
  SubagentStatus,
  SubagentOptions,
  SubagentHandle,
  SubagentStatusCallback,
} from './subagent-types.js';

const logger = createLogger('SubagentManager');

/**
 * Manager for spawning and tracking subagents.
 *
 * Provides a unified interface for creating subagents of different types:
 * - **schedule**: For scheduled task execution
 * - **task**: For one-time task execution
 *
 * Both types use the same ChatAgent implementation via AgentFactory.createAgent().
 */
export class SubagentManager {
  private handles: Map<string, SubagentHandle> = new Map();
  private processes: Map<string, import('child_process').ChildProcess> = new Map();
  private inMemoryAgents: Map<string, ChatAgent> = new Map();
  private statusCallbacks: Set<SubagentStatusCallback> = new Set();

  /** Register a callback for status changes. Returns unsubscribe function. */
  onStatusChange(callback: SubagentStatusCallback): () => void {
    this.statusCallbacks.add(callback);
    return () => this.statusCallbacks.delete(callback);
  }

  /** Notify all registered callbacks of a status change. */
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
      if (options.type !== 'schedule' && options.type !== 'task') {
        throw new Error(`Unknown subagent type: ${options.type}`);
      }
      await this.spawnInMemoryAgent(subagentId, options);
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
   * Spawn an in-memory agent (shared implementation for schedule/task types).
   *
   * Issue #2345 Phase 4: Previously had separate spawnScheduleAgent() and
   * spawnTaskAgent() with identical logic — now unified into this method.
   */
  private async spawnInMemoryAgent(
    subagentId: string,
    options: SubagentOptions
  ): Promise<void> {
    const handle = this.handles.get(subagentId);
    if (!handle) {
      throw new Error(`Subagent handle not found: ${subagentId}`);
    }

    const agent = AgentFactory.createAgent(options.chatId, options.callbacks);
    this.inMemoryAgents.set(subagentId, agent);
    handle.status = 'running';

    logger.info({ subagentId, name: options.name, type: options.type }, 'Subagent started');
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

  /** Get information about a specific subagent. */
  get(subagentId: string): SubagentHandle | undefined {
    return this.handles.get(subagentId);
  }

  /** Get status of a specific subagent. */
  getStatus(subagentId: string): SubagentStatus | undefined {
    return this.handles.get(subagentId)?.status;
  }

  /** List all subagents, optionally filtered by status. */
  list(status?: SubagentStatus): SubagentHandle[] {
    const allHandles = Array.from(this.handles.values());
    return status ? allHandles.filter(h => h.status === status) : allHandles;
  }

  /** List running subagents. */
  listRunning(): SubagentHandle[] {
    return this.list('running');
  }

  /** Terminate all running subagents. */
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

  /** Dispose of all resources. */
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

/** Get the global SubagentManager instance. */
export function getSubagentManager(): SubagentManager | undefined {
  return globalManager;
}

/** Initialize the global SubagentManager. */
export function initSubagentManager(): SubagentManager {
  globalManager = new SubagentManager();
  return globalManager;
}

/** Reset the global manager (for testing). */
export function resetSubagentManager(): void {
  if (globalManager) {
    void globalManager.dispose();
  }
  globalManager = undefined;
}
