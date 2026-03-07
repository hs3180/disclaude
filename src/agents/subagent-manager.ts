/**
 * SubagentManager - Unified interface for spawning and managing subagents.
 *
 * Issue #997: Unifies subagent spawning methods across:
 * - Schedule Task agents
 * - Skill agents
 * - Task tool agents
 *
 * Features:
 * - Unified spawn API for all subagent types
 * - Lifecycle management (start, stop, status)
 * - Optional worktree isolation
 * - Progress callbacks
 * - Logging and monitoring
 *
 * @module agents/subagent-manager
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { AgentFactory, type AgentCreateOptions } from './factory.js';
import type { PilotCallbacks, PilotConfig } from './pilot/index.js';
import type { ChatAgent, Subagent, SkillAgent, BaseAgentConfig, AgentProvider } from './types.js';

const logger = createLogger('SubagentManager');

// ============================================================================
// Subagent Types
// ============================================================================

/**
 * Types of subagents that can be spawned.
 */
export type SubagentType = 'schedule' | 'skill' | 'task';

/**
 * Status of a subagent.
 */
export type SubagentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Isolation mode for subagent execution.
 */
export type IsolationMode = 'worktree' | 'none';

/**
 * Options for spawning a subagent.
 */
export interface SubagentOptions {
  /** Type of subagent to spawn */
  type: SubagentType;
  /** Human-readable name for the subagent */
  name: string;
  /** Prompt/task for the subagent to execute */
  prompt: string;
  /** Chat ID for message delivery */
  chatId: string;
  /** Callbacks for sending messages */
  callbacks: PilotCallbacks;
  /** Isolation mode (worktree for git isolation) */
  isolation?: IsolationMode;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Progress callback */
  onProgress?: (message: string) => void;
  /** Optional configuration overrides */
  config?: AgentCreateOptions;
  /** For skill agents: skill name to execute */
  skillName?: string;
  /** For schedule agents: task ID for tracking */
  taskId?: string;
}

/**
 * Handle to a spawned subagent.
 */
export interface SubagentHandle {
  /** Unique identifier for this subagent instance */
  id: string;
  /** Type of subagent */
  type: SubagentType;
  /** Human-readable name */
  name: string;
  /** Current status */
  status: SubagentStatus;
  /** Chat ID associated with this subagent */
  chatId: string;
  /** Start time */
  startedAt: Date;
  /** Completion time (if completed) */
  completedAt?: Date;
  /** Error message (if failed) */
  error?: string;
  /** Output from the subagent */
  output?: string;
  /** Process ID (if running in separate process) */
  pid?: number;
  /** Whether worktree isolation is active */
  isIsolated: boolean;
  /** The underlying agent instance */
  agent?: ChatAgent | Subagent | SkillAgent;
}

/**
 * Callback for subagent events.
 */
export interface SubagentEventCallbacks {
  /** Called when subagent starts */
  onStart?: (handle: SubagentHandle) => void;
  /** Called on progress updates */
  onProgress?: (handle: SubagentHandle, message: string) => void;
  /** Called when subagent completes */
  onComplete?: (handle: SubagentHandle, output: string) => void;
  /** Called when subagent fails */
  onError?: (handle: SubagentHandle, error: Error) => void;
}

/**
 * Configuration for SubagentManager.
 */
export interface SubagentManagerConfig {
  /** Event callbacks */
  callbacks?: SubagentEventCallbacks;
  /** Default timeout for subagents (ms) */
  defaultTimeout?: number;
  /** Maximum concurrent subagents */
  maxConcurrent?: number;
}

// ============================================================================
// SubagentManager Implementation
// ============================================================================

/**
 * Manager for spawning and tracking subagents.
 *
 * Provides a unified interface for creating subagents across different
 * use cases (schedule, skill, task).
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager();
 *
 * // Spawn a schedule agent
 * const handle = await manager.spawn({
 *   type: 'schedule',
 *   name: 'PR Scanner',
 *   prompt: 'Scan for new PRs...',
 *   chatId: 'chat-123',
 *   callbacks: { sendMessage, sendCard, sendFile },
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
  private eventCallbacks?: SubagentEventCallbacks;
  private defaultTimeout: number;
  private maxConcurrent: number;

  constructor(config: SubagentManagerConfig = {}) {
    this.eventCallbacks = config.callbacks;
    this.defaultTimeout = config.defaultTimeout ?? 3600000; // 1 hour default
    this.maxConcurrent = config.maxConcurrent ?? 10;
  }

  /**
   * Spawn a new subagent.
   *
   * Creates and starts a subagent based on the specified type.
   *
   * @param options - Subagent spawn options
   * @returns Handle to the spawned subagent
   */
  async spawn(options: SubagentOptions): Promise<SubagentHandle> {
    // Check concurrent limit
    const runningCount = this.list('running').length + this.list('starting').length;
    if (runningCount >= this.maxConcurrent) {
      throw new Error(`Maximum concurrent subagents reached (${this.maxConcurrent})`);
    }

    const id = this.generateId(options.type);
    const handle: SubagentHandle = {
      id,
      type: options.type,
      name: options.name,
      status: 'starting',
      chatId: options.chatId,
      startedAt: new Date(),
      isIsolated: options.isolation === 'worktree',
    };

    this.handles.set(id, handle);

    try {
      // Create agent based on type
      switch (options.type) {
        case 'schedule':
          handle.agent = await this.createScheduleAgent(options);
          break;
        case 'skill':
          handle.agent = await this.createSkillAgent(options);
          break;
        case 'task':
          handle.agent = await this.createTaskAgent(options);
          break;
        default:
          throw new Error(`Unknown subagent type: ${options.type}`);
      }

      handle.status = 'running';
      this.eventCallbacks?.onStart?.(handle);
      logger.info({ id, type: options.type, name: options.name }, 'Subagent spawned');

      // Execute the subagent task
      this.executeSubagent(handle, options).catch((error) => {
        this.handleSubagentError(handle, error);
      });

    } catch (error) {
      handle.status = 'failed';
      handle.error = error instanceof Error ? error.message : String(error);
      handle.completedAt = new Date();
      this.eventCallbacks?.onError?.(handle, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }

    return handle;
  }

  /**
   * Get a subagent handle by ID.
   *
   * @param id - Subagent ID
   * @returns Handle or undefined
   */
  get(id: string): SubagentHandle | undefined {
    return this.handles.get(id);
  }

  /**
   * Get status of a subagent.
   *
   * @param id - Subagent ID
   * @returns Status or undefined
   */
  getStatus(id: string): SubagentStatus | undefined {
    return this.handles.get(id)?.status;
  }

  /**
   * List subagents, optionally filtered by status.
   *
   * @param status - Optional status filter
   * @returns Array of subagent handles
   */
  list(status?: SubagentStatus): SubagentHandle[] {
    const allHandles = Array.from(this.handles.values());

    if (status) {
      return allHandles.filter((h) => h.status === status);
    }

    return allHandles;
  }

  /**
   * List all running subagents.
   *
   * @returns Array of running subagent handles
   */
  listRunning(): SubagentHandle[] {
    return this.list('running');
  }

  /**
   * Terminate a subagent.
   *
   * @param id - Subagent ID to terminate
   * @returns True if terminated, false if not found
   */
  async terminate(id: string): Promise<boolean> {
    const handle = this.handles.get(id);
    if (!handle) {
      return false;
    }

    if (handle.status === 'running' || handle.status === 'starting') {
      handle.status = 'stopped';
      handle.completedAt = new Date();

      // Dispose the agent if it has a dispose method
      if (handle.agent && 'dispose' in handle.agent) {
        try {
          (handle.agent as { dispose: () => void }).dispose();
        } catch (err) {
          logger.error({ err, id }, 'Error disposing subagent');
        }
      }

      logger.info({ id }, 'Subagent terminated');
    }

    return true;
  }

  /**
   * Terminate all running subagents.
   */
  async terminateAll(): Promise<void> {
    const running = this.listRunning();
    for (const handle of running) {
      await this.terminate(handle.id);
    }
    logger.info({ count: running.length }, 'All subagents terminated');
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
  async dispose(): Promise<void> {
    await this.terminateAll();
    this.handles.clear();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Generate a unique ID for a subagent.
   */
  private generateId(type: SubagentType): string {
    const prefix = type === 'schedule' ? 'sched' : type === 'skill' ? 'skill' : 'task';
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Create a schedule agent.
   */
  private async createScheduleAgent(options: SubagentOptions): Promise<ChatAgent> {
    return AgentFactory.createScheduleAgent(
      options.chatId,
      options.callbacks,
      options.config
    );
  }

  /**
   * Create a skill agent.
   */
  private async createSkillAgent(options: SubagentOptions): Promise<SkillAgent> {
    if (!options.skillName) {
      throw new Error('skillName is required for skill type subagents');
    }

    return AgentFactory.createSkillAgent(options.skillName, options.config);
  }

  /**
   * Create a task agent.
   */
  private async createTaskAgent(options: SubagentOptions): Promise<ChatAgent> {
    return AgentFactory.createTaskAgent(
      options.chatId,
      options.callbacks,
      options.config
    );
  }

  /**
   * Execute a subagent task.
   */
  private async executeSubagent(handle: SubagentHandle, options: SubagentOptions): Promise<void> {
    const timeout = options.timeout ?? this.defaultTimeout;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      // Set up timeout
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Subagent timeout after ${timeout}ms`));
        }, timeout);
      });

      // Execute based on agent type
      const executePromise = this.executeAgentTask(handle, options);

      await Promise.race([executePromise, timeoutPromise]);

      handle.status = 'completed';
      handle.completedAt = new Date();
      this.eventCallbacks?.onComplete?.(handle, handle.output ?? '');
      logger.info({ id: handle.id }, 'Subagent completed');

    } catch (error) {
      this.handleSubagentError(handle, error);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Execute the actual agent task.
   */
  private async executeAgentTask(handle: SubagentHandle, options: SubagentOptions): Promise<void> {
    const agent = handle.agent;

    if (!agent) {
      throw new Error('No agent instance available');
    }

    // Collect output
    let output = '';

    if ('executeOnce' in agent && typeof agent.executeOnce === 'function') {
      // ChatAgent (ScheduleAgent, TaskAgent)
      await (agent as ChatAgent).executeOnce(
        options.chatId,
        options.prompt,
        undefined,
        undefined
      );
    } else if ('execute' in agent && typeof agent.execute === 'function') {
      // SkillAgent
      for await (const message of (agent as SkillAgent).execute(options.prompt)) {
        if (message.content) {
          output += message.content + '\n';
        }
        options.onProgress?.(message.content);
        this.eventCallbacks?.onProgress?.(handle, message.content);
      }
      handle.output = output;
    } else {
      throw new Error('Agent does not have a valid execute method');
    }
  }

  /**
   * Handle subagent error.
   */
  private handleSubagentError(handle: SubagentHandle, error: unknown): void {
    handle.status = 'failed';
    handle.error = error instanceof Error ? error.message : String(error);
    handle.completedAt = new Date();

    this.eventCallbacks?.onError?.(
      handle,
      error instanceof Error ? error : new Error(String(error))
    );

    logger.error({ err: error, id: handle.id }, 'Subagent failed');
  }
}

// ============================================================================
// Global Instance (Optional Singleton Pattern)
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
export function initSubagentManager(config?: SubagentManagerConfig): SubagentManager {
  globalManager = new SubagentManager(config);
  return globalManager;
}

/**
 * Reset the global manager (for testing).
 */
export function resetSubagentManager(): void {
  globalManager = undefined;
}
