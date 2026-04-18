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
import { createLogger, type ChatAgent, ProgressReporter, type SendCardCallback } from '@disclaude/core';
import { AgentFactory } from './factory.js';
import type { ChatAgentCallbacks } from './chat-agent/index.js';

const logger = createLogger('SubagentManager');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Type of subagent to spawn.
 *
 * Issue #1501: 'skill' type removed. Skills are now handled via
 * ChatAgent.executeOnce() or .md-defined subagents.
 */
export type SubagentType = 'schedule' | 'task';

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
 *   type: 'task',
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
  /** Type of subagent to spawn */
  type: SubagentType;
  /** Name/identifier for the subagent */
  name: string;
  /** Prompt/task for the subagent to execute */
  prompt: string;
  /** Chat ID for message delivery */
  chatId: string;
  /** Callbacks for sending messages */
  callbacks: ChatAgentCallbacks;
  /** Optional cron expression for scheduled execution (only for type='schedule') */
  schedule?: string;
  /** Optional timeout in milliseconds */
  timeout?: number;
  /** Isolation mode (default: 'none') */
  isolation?: IsolationMode;
  /** Optional progress callback */
  onProgress?: (message: string) => void;
  /** Optional sender OpenId for scheduled tasks */
  senderOpenId?: string;
  /**
   * Enable periodic progress card reporting.
   * When true, sends progress cards every 60 seconds while the agent is running.
   * Issue #857: Task progress tracking for complex tasks.
   */
  enableProgress?: boolean;
}

/**
 * Handle to a spawned subagent.
 *
 * Provides status tracking and control over the subagent lifecycle.
 */
export interface SubagentHandle {
  /** Unique subagent ID */
  id: string;
  /** Subagent type */
  type: SubagentType;
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
  private inMemoryAgents: Map<string, ChatAgent> = new Map();
  private statusCallbacks: Set<SubagentStatusCallback> = new Set();
  /** Issue #857: Optional progress reporter for running subagents */
  private progressReporters: Map<string, ProgressReporter> = new Map();

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

    // Issue #857: Start progress tracking if enabled
    if (options.enableProgress) {
      this.startProgressTracking(subagentId, options);
    }

    try {
      switch (options.type) {
        case 'schedule':
          await this.spawnScheduleAgent(subagentId, options);
          break;
        case 'task':
          await this.spawnTaskAgent(subagentId, options);
          break;
        default:
          throw new Error(`Unknown subagent type: ${options.type}`);
      }
    } catch (error) {
      handle.status = 'failed';
      handle.error = error instanceof Error ? error.message : String(error);
      handle.completedAt = new Date();
      this.notifyStatusChange(handle);
      // Issue #857: Stop progress tracking on failure
      void this.stopProgressTracking(subagentId, 'failed').catch(() => {
        // Ignore errors during cleanup in catch block
      });
      throw error;
    }

    return handle;
  }

  /**
   * Issue #857: Start progress tracking for a subagent.
   */
  private startProgressTracking(subagentId: string, options: SubagentOptions): void {
    try {
      const sendCard: SendCardCallback = async (chatId, card, description) => {
        await options.callbacks.sendCard(chatId, card, description);
      };

      const reporter = new ProgressReporter({
        sendCard,
        reportIntervalMs: 60_000, // 60 seconds
      });

      reporter.startTracking(subagentId, options.chatId, options.name);
      this.progressReporters.set(subagentId, reporter);
      logger.info({ subagentId }, 'Progress tracking started');
    } catch (error) {
      logger.error({ err: error, subagentId }, 'Failed to start progress tracking');
    }
  }

  /**
   * Issue #857: Stop progress tracking for a subagent.
   */
  private async stopProgressTracking(
    subagentId: string,
    finalStatus: 'completed' | 'failed' | 'stopped'
  ): Promise<void> {
    const reporter = this.progressReporters.get(subagentId);
    if (!reporter) {return;}

    try {
      await reporter.stopTracking(subagentId, finalStatus);
      reporter.dispose();
      this.progressReporters.delete(subagentId);
      logger.info({ subagentId, finalStatus }, 'Progress tracking stopped');
    } catch (error) {
      logger.error({ err: error, subagentId }, 'Failed to stop progress tracking');
    }
  }

  /**
   * Issue #857: Update progress status for a tracked subagent.
   */
  private updateProgressStatus(subagentId: string, status: 'starting' | 'running' | 'completed' | 'failed' | 'stopped'): void {
    const reporter = this.progressReporters.get(subagentId);
    if (!reporter) {return;}
    reporter.updateStatus(subagentId, status);
  }

  /**
   * Spawn a schedule agent in memory.
   */
  private async spawnScheduleAgent(
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

    // Issue #857: Update progress reporter status
    this.updateProgressStatus(subagentId, 'running');

    logger.info({ subagentId, name: options.name }, 'Schedule subagent started');
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
      logger.info({ subagentId }, 'Schedule subagent completed');
    } catch (error) {
      handle.status = 'failed';
      handle.error = error instanceof Error ? error.message : String(error);
      handle.completedAt = new Date();
      logger.error({ err: error, subagentId }, 'Schedule subagent failed');
    }

    this.notifyStatusChange(handle);

    // Issue #857: Stop progress tracking
    await this.stopProgressTracking(subagentId, handle.status === 'completed' ? 'completed' : 'failed');

    // Cleanup
    try {
      agent.dispose();
    } catch (err) {
      logger.error({ err, subagentId }, 'Error disposing schedule agent');
    }
    this.inMemoryAgents.delete(subagentId);
  }

  /**
   * Spawn a task agent in memory.
   */
  private async spawnTaskAgent(
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

    // Issue #857: Update progress reporter status
    this.updateProgressStatus(subagentId, 'running');

    logger.info({ subagentId, name: options.name }, 'Task subagent started');
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
      logger.info({ subagentId }, 'Task subagent completed');
    } catch (error) {
      handle.status = 'failed';
      handle.error = error instanceof Error ? error.message : String(error);
      handle.completedAt = new Date();
      logger.error({ err: error, subagentId }, 'Task subagent failed');
    }

    this.notifyStatusChange(handle);

    // Issue #857: Stop progress tracking
    await this.stopProgressTracking(subagentId, handle.status === 'completed' ? 'completed' : 'failed');

    // Cleanup
    try {
      agent.dispose();
    } catch (err) {
      logger.error({ err, subagentId }, 'Error disposing task agent');
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

    // Issue #857: Stop progress tracking
    void this.stopProgressTracking(subagentId, 'stopped');

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
    // Issue #857: Clean up all progress reporters
    for (const reporter of this.progressReporters.values()) {
      reporter.dispose();
    }
    this.progressReporters.clear();
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
