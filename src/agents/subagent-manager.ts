/**
 * SubagentManager - Unified interface for spawning and managing subagents.
 *
 * Issue #997: Unify subagent spawn methods (schedule task + skill agent + task tool)
 *
 * This module provides a unified API for creating and managing subagents
 * across different use cases:
 * - Schedule Task: Cron-based scheduled task execution
 * - Skill Agent: Background skill execution
 * - Task Tool: General-purpose task agents
 *
 * Key Features:
 * - Unified spawn interface with consistent options
 * - Lifecycle management (start, stop, status)
 * - Resource isolation support (worktree)
 * - Logging and progress tracking
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager(callbacks);
 *
 * // Spawn a schedule task agent
 * const handle = await manager.spawn({
 *   type: 'schedule',
 *   name: 'daily-report',
 *   prompt: 'Generate daily report...',
 *   chatId: 'chat-123',
 * });
 *
 * // List all running subagents
 * const agents = manager.list();
 *
 * // Terminate a subagent
 * await manager.terminate(handle.id);
 * ```
 *
 * @module agents/subagent-manager
 */

import { v4 as uuidv4 } from 'uuid';
import { AgentFactory, type AgentCreateOptions } from './factory.js';
import type { PilotCallbacks, ChatAgent, SkillAgent } from './types.js';

// ============================================================================
// Subagent Types
// ============================================================================

/**
 * Subagent type identifier.
 * - schedule: Scheduled task agent (cron-based)
 * - skill: Background skill agent
 * - task: General-purpose task agent
 */
export type SubagentType = 'schedule' | 'skill' | 'task';

/**
 * Isolation mode for subagent execution.
 * - none: No isolation, runs in current context
 * - worktree: Isolated in a git worktree
 */
export type IsolationMode = 'none' | 'worktree';

/**
 * Status of a subagent.
 */
export type SubagentStatus = 'spawning' | 'running' | 'completed' | 'failed' | 'terminated';

/**
 * Options for spawning a subagent.
 */
export interface SubagentOptions {
  /** Type of subagent to spawn */
  type: SubagentType;
  /** Human-readable name for the subagent */
  name: string;
  /** Prompt/instructions for the subagent */
  prompt: string;
  /** Target chat ID for message delivery */
  chatId: string;
  /** Isolation mode (default: 'none') */
  isolation?: IsolationMode;
  /** Timeout in milliseconds (optional) */
  timeout?: number;
  /** Progress callback (optional) */
  onProgress?: (message: string) => void;
  /** Additional configuration options */
  config?: AgentCreateOptions;
  /** Skill name (required when type is 'skill') */
  skillName?: string;
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
  /** Target chat ID */
  chatId: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Completion timestamp (if completed) */
  completedAt?: Date;
  /** Error message (if failed) */
  error?: string;
  /** Progress messages */
  progress: string[];
  /** The underlying agent instance */
  agent?: ChatAgent | SkillAgent;
}

/**
 * Internal record for tracking subagent state.
 */
interface SubagentRecord extends SubagentHandle {
  /** The underlying agent instance */
  agent: ChatAgent | SkillAgent;
  /** Abort controller for cancellation */
  abortController?: AbortController;
  /** Promise representing the running task */
  promise?: Promise<void>;
}

// ============================================================================
// SubagentManager Implementation
// ============================================================================

/**
 * Manager for spawning and tracking subagents.
 *
 * Provides a unified interface for creating different types of subagents
 * with consistent lifecycle management.
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager({
 *   sendMessage: async (chatId, text) => { ... },
 *   sendCard: async (chatId, card) => { ... },
 *   sendFile: async (chatId, filePath) => { ... },
 * });
 *
 * // Spawn and track a subagent
 * const handle = await manager.spawn({
 *   type: 'task',
 *   name: 'data-analysis',
 *   prompt: 'Analyze the sales data...',
 *   chatId: 'chat-123',
 * });
 *
 * // Check status
 * console.log(handle.status); // 'running'
 *
 * // List all subagents
 * manager.list().forEach(h => console.log(h.name, h.status));
 *
 * // Terminate if needed
 * await manager.terminate(handle.id);
 * ```
 */
export class SubagentManager {
  private readonly callbacks: PilotCallbacks;
  private readonly subagents: Map<string, SubagentRecord> = new Map();

  /**
   * Create a new SubagentManager.
   *
   * @param callbacks - Callbacks for sending messages
   */
  constructor(callbacks: PilotCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Spawn a new subagent.
   *
   * Creates and starts a subagent based on the provided options.
   * The subagent runs asynchronously and can be tracked via the handle.
   *
   * @param options - Spawn options
   * @returns Handle to the spawned subagent
   * @throws Error if spawn fails
   *
   * @example
   * ```typescript
   * // Spawn a task agent
   * const handle = await manager.spawn({
   *   type: 'task',
   *   name: 'code-review',
   *   prompt: 'Review the changes in PR #123',
   *   chatId: 'chat-456',
   * });
   * ```
   */
  async spawn(options: SubagentOptions): Promise<SubagentHandle> {
    const id = uuidv4();
    const createdAt = new Date();

    // Create initial record
    const record: SubagentRecord = {
      id,
      type: options.type,
      name: options.name,
      status: 'spawning',
      chatId: options.chatId,
      createdAt,
      progress: [],
      agent: undefined as unknown as ChatAgent | SkillAgent,
    };

    this.subagents.set(id, record);

    try {
      // Create the appropriate agent based on type
      switch (options.type) {
        case 'schedule':
          record.agent = AgentFactory.createScheduleAgent(
            options.chatId,
            this.callbacks,
            options.config
          );
          break;

        case 'task':
          record.agent = AgentFactory.createTaskAgent(
            options.chatId,
            this.callbacks,
            options.config
          );
          break;

        case 'skill':
          if (!options.skillName) {
            throw new Error('skillName is required for skill type subagents');
          }
          record.agent = await AgentFactory.createSkillAgent(
            options.skillName,
            options.config
          );
          break;

        default:
          throw new Error(`Unknown subagent type: ${options.type}`);
      }

      // Update status to running
      record.status = 'running';

      // Set up abort controller for timeout/cancellation
      const abortController = new AbortController();
      record.abortController = abortController;

      // Set up timeout if specified
      let timeoutId: NodeJS.Timeout | undefined;
      if (options.timeout) {
        timeoutId = setTimeout(() => {
          this.terminate(id, 'Timeout exceeded');
        }, options.timeout);
      }

      // Progress callback wrapper
      const reportProgress = (message: string) => {
        record.progress.push(message);
        options.onProgress?.(message);
      };

      // Execute the agent
      record.promise = this.executeAgent(record, options, reportProgress)
        .then(() => {
          record.status = 'completed';
          record.completedAt = new Date();
        })
        .catch((error) => {
          if (record.status !== 'terminated') {
            record.status = 'failed';
            record.error = error instanceof Error ? error.message : String(error);
            record.completedAt = new Date();
          }
        })
        .finally(() => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          record.agent?.dispose();
        });

      // Return handle (without internal agent reference)
      return this.toHandle(record);
    } catch (error) {
      // Clean up on spawn failure
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = new Date();
      throw error;
    }
  }

  /**
   * Execute the agent with the given prompt.
   */
  private async executeAgent(
    record: SubagentRecord,
    options: SubagentOptions,
    reportProgress: (message: string) => void
  ): Promise<void> {
    reportProgress(`Starting ${options.type} agent: ${options.name}`);

    if ('executeOnce' in record.agent && typeof record.agent.executeOnce === 'function') {
      // ChatAgent - use executeOnce
      await record.agent.executeOnce(
        options.chatId,
        options.prompt,
        undefined,
        undefined
      );
    } else if ('execute' in record.agent && typeof record.agent.execute === 'function') {
      // SkillAgent - use execute
      for await (const response of record.agent.execute(options.prompt)) {
        if (response.content) {
          reportProgress(response.content);
        }
      }
    } else {
      throw new Error('Agent does not have a valid execution method');
    }

    reportProgress(`Completed ${options.type} agent: ${options.name}`);
  }

  /**
   * List all tracked subagents.
   *
   * @returns Array of subagent handles
   */
  list(): SubagentHandle[] {
    return Array.from(this.subagents.values()).map((r) => this.toHandle(r));
  }

  /**
   * Get a specific subagent by ID.
   *
   * @param id - Subagent ID
   * @returns Subagent handle or undefined if not found
   */
  get(id: string): SubagentHandle | undefined {
    const record = this.subagents.get(id);
    return record ? this.toHandle(record) : undefined;
  }

  /**
   * Terminate a running subagent.
   *
   * @param id - Subagent ID
   * @param reason - Optional reason for termination
   * @returns true if terminated, false if not found or already completed
   */
  async terminate(id: string, reason?: string): Promise<boolean> {
    const record = this.subagents.get(id);
    if (!record) {
      return false;
    }

    if (record.status !== 'running' && record.status !== 'spawning') {
      return false;
    }

    // Update status
    record.status = 'terminated';
    record.error = reason ?? 'Terminated by user';
    record.completedAt = new Date();

    // Abort if controller exists
    record.abortController?.abort();

    // Dispose the agent
    try {
      record.agent?.dispose();
    } catch {
      // Ignore disposal errors
    }

    return true;
  }

  /**
   * Clean up completed/terminated subagents from tracking.
   *
   * @param maxAge - Maximum age in milliseconds for keeping completed records
   */
  cleanup(maxAge: number = 3600000): void {
    const now = Date.now();
    for (const [id, record] of this.subagents.entries()) {
      if (
        (record.status === 'completed' ||
          record.status === 'failed' ||
          record.status === 'terminated') &&
        record.completedAt &&
        now - record.completedAt.getTime() > maxAge
      ) {
        this.subagents.delete(id);
      }
    }
  }

  /**
   * Convert internal record to public handle.
   */
  private toHandle(record: SubagentRecord): SubagentHandle {
    return {
      id: record.id,
      type: record.type,
      name: record.name,
      status: record.status,
      chatId: record.chatId,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      error: record.error,
      progress: [...record.progress],
    };
  }
}

// ============================================================================
// Singleton Instance (optional)
// ============================================================================

let defaultManager: SubagentManager | undefined;

/**
 * Get or create the default SubagentManager instance.
 *
 * @param callbacks - Callbacks for the manager (required on first call)
 * @returns SubagentManager instance
 */
export function getSubagentManager(callbacks?: PilotCallbacks): SubagentManager {
  if (!defaultManager) {
    if (!callbacks) {
      throw new Error('Callbacks required for first initialization');
    }
    defaultManager = new SubagentManager(callbacks);
  }
  return defaultManager;
}

/**
 * Reset the default manager (for testing).
 */
export function resetSubagentManager(): void {
  defaultManager = undefined;
}
