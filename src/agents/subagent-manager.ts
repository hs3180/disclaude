/**
 * SubagentManager - Unified interface for spawning and managing subagents.
 *
 * Issue #997: Unified subagent spawn method (schedule task + skill agent)
 *
 * This module provides a consistent API for creating and managing all types
 * of subagents in the system:
 * - schedule: Short-lived agents for scheduled tasks
 * - skill: Background agents running in separate processes
 * - task: One-time task agents
 * - subagent: Specialized agents like site-miner
 *
 * Features:
 * - Unified spawn interface with consistent options
 * - Lifecycle management (start, stop, status)
 * - Resource isolation support (worktree)
 * - Unified logging and status tracking
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager(callbacks);
 *
 * // Spawn a schedule agent
 * const handle = await manager.spawn({
 *   type: 'schedule',
 *   name: 'daily-report',
 *   chatId: 'chat-123',
 *   prompt: 'Generate daily report...',
 * });
 *
 * // Check status
 * const status = manager.getStatus(handle.id);
 *
 * // Terminate
 * await manager.terminate(handle.id);
 * ```
 *
 * @module agents/subagent-manager
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { AgentFactory, type AgentCreateOptions } from './factory.js';
import { SkillAgentManager, type NotificationCallbacks, type AgentStatus } from './skill-agent-manager.js';
import type { ChatAgent, Subagent } from './types.js';
import type { PilotCallbacks } from './pilot/index.js';

const logger = createLogger('SubagentManager');

/**
 * Type of subagent to spawn.
 */
export type SubagentType = 'schedule' | 'skill' | 'task' | 'subagent';

/**
 * Options for spawning a subagent.
 */
export interface SubagentOptions {
  /** Type of subagent */
  type: SubagentType;
  /** Name/identifier for the subagent */
  name: string;
  /** Target chat ID for notifications */
  chatId: string;
  /** Prompt or task description */
  prompt?: string;
  /** Skill name (required for type='skill') */
  skillName?: string;
  /** Subagent type (required for type='subagent', e.g., 'site-miner') */
  subagentType?: string;
  /** Template variables for skill agents */
  templateVars?: Record<string, string>;
  /** Cron schedule for recurring execution (type='skill' only) */
  schedule?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Isolation mode - not yet implemented, reserved for future */
  isolation?: 'worktree' | 'none';
  /** Callback for progress updates */
  onProgress?: (message: string) => void;
  /** Agent creation options (model, apiKey, etc.) */
  agentOptions?: AgentCreateOptions;
}

/**
 * Handle to a spawned subagent.
 */
export interface SubagentHandle {
  /** Unique identifier */
  id: string;
  /** Type of subagent */
  type: SubagentType;
  /** Name/identifier */
  name: string;
  /** Target chat ID */
  chatId: string;
  /** Current status */
  status: AgentStatus;
  /** Creation time */
  createdAt: Date;
  /** Completion time (if completed) */
  completedAt?: Date;
  /** Error message (if failed) */
  error?: string;
  /** Process ID (for skill agents running in separate process) */
  pid?: number;
  /** Schedule expression (if scheduled) */
  schedule?: string;
}

/**
 * Internal tracking info for spawned agents.
 */
interface AgentInfo {
  handle: SubagentHandle;
  instance?: ChatAgent | Subagent;
  skillAgentId?: string;
}

/**
 * Callbacks required by SubagentManager.
 */
export type SubagentManagerCallbacks = NotificationCallbacks & PilotCallbacks;

/**
 * Unified manager for spawning and managing subagents.
 *
 * Provides a consistent interface for all subagent types in the system.
 * Internally delegates to appropriate managers (AgentFactory, SkillAgentManager).
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager({
 *   sendMessage: async (chatId, text) => { ... },
 *   sendCard: async (chatId, card) => { ... },
 *   sendFile: async (chatId, filePath) => { ... },
 * });
 *
 * // Spawn a schedule agent
 * const handle = await manager.spawn({
 *   type: 'schedule',
 *   name: 'daily-report',
 *   chatId: 'chat-123',
 *   prompt: 'Generate daily report...',
 * });
 *
 * // List all running agents
 * const agents = manager.list();
 *
 * // Terminate an agent
 * await manager.terminate(handle.id);
 * ```
 */
export class SubagentManager {
  private agents: Map<string, AgentInfo> = new Map();
  private callbacks: SubagentManagerCallbacks;
  private skillAgentManager: SkillAgentManager;

  constructor(callbacks: SubagentManagerCallbacks) {
    this.callbacks = callbacks;
    this.skillAgentManager = new SkillAgentManager(callbacks);
    logger.info('SubagentManager initialized');
  }

  /**
   * Spawn a new subagent.
   *
   * @param options - Spawn options
   * @returns Handle to the spawned subagent
   */
  async spawn(options: SubagentOptions): Promise<SubagentHandle> {
    const id = this.generateId(options.type);
    const handle: SubagentHandle = {
      id,
      type: options.type,
      name: options.name,
      chatId: options.chatId,
      status: 'starting',
      createdAt: new Date(),
      schedule: options.schedule,
    };

    const info: AgentInfo = { handle };
    this.agents.set(id, info);

    try {
      switch (options.type) {
        case 'schedule':
          await this.spawnScheduleAgent(info, options);
          break;
        case 'skill':
          await this.spawnSkillAgent(info, options);
          break;
        case 'task':
          await this.spawnTaskAgent(info, options);
          break;
        case 'subagent':
          await this.spawnSubagentInstance(info, options);
          break;
        default:
          throw new Error(`Unknown subagent type: ${options.type}`);
      }

      logger.info({ id, type: options.type, name: options.name }, 'Subagent spawned');
      return handle;
    } catch (error) {
      handle.status = 'failed';
      handle.error = error instanceof Error ? error.message : String(error);
      handle.completedAt = new Date();
      logger.error({ err: error, id, type: options.type }, 'Failed to spawn subagent');
      throw error;
    }
  }

  /**
   * Spawn a schedule agent.
   */
  private async spawnScheduleAgent(info: AgentInfo, options: SubagentOptions): Promise<void> {
    const agent = AgentFactory.createScheduleAgent(
      options.chatId,
      this.callbacks,
      options.agentOptions
    );

    info.instance = agent;
    info.handle.status = 'running';

    // Execute the prompt if provided
    if (options.prompt) {
      try {
        await agent.executeOnce(options.chatId, options.prompt, undefined);
        info.handle.status = 'completed';
        info.handle.completedAt = new Date();
      } catch (error) {
        info.handle.status = 'failed';
        info.handle.error = error instanceof Error ? error.message : String(error);
        info.handle.completedAt = new Date();
      } finally {
        agent.dispose();
        info.instance = undefined;
      }
    }
  }

  /**
   * Spawn a skill agent in a separate process.
   */
  private async spawnSkillAgent(info: AgentInfo, options: SubagentOptions): Promise<void> {
    if (!options.skillName) {
      throw new Error('skillName is required for skill agent type');
    }

    const skillAgentId = await this.skillAgentManager.start({
      skillName: options.skillName,
      chatId: options.chatId,
      templateVars: options.templateVars,
      schedule: options.schedule,
      timeout: options.timeout,
    });

    info.skillAgentId = skillAgentId;
    info.handle.status = 'running';

    // Get PID from skill agent manager
    const skillInfo = this.skillAgentManager.get(skillAgentId);
    if (skillInfo) {
      info.handle.pid = skillInfo.pid;
    }
  }

  /**
   * Spawn a task agent.
   */
  private async spawnTaskAgent(info: AgentInfo, options: SubagentOptions): Promise<void> {
    const agent = AgentFactory.createTaskAgent(
      options.chatId,
      this.callbacks,
      options.agentOptions
    );

    info.instance = agent;
    info.handle.status = 'running';

    // Execute the prompt if provided
    if (options.prompt) {
      try {
        await agent.executeOnce(options.chatId, options.prompt, undefined);
        info.handle.status = 'completed';
        info.handle.completedAt = new Date();
      } catch (error) {
        info.handle.status = 'failed';
        info.handle.error = error instanceof Error ? error.message : String(error);
        info.handle.completedAt = new Date();
      } finally {
        agent.dispose();
        info.instance = undefined;
      }
    }
  }

  /**
   * Spawn a specialized subagent (e.g., site-miner).
   */
  private spawnSubagentInstance(info: AgentInfo, options: SubagentOptions): void {
    const subagentType = options.subagentType || options.name;
    const subagent = AgentFactory.createSubagent(subagentType, options.agentOptions);

    info.instance = subagent;
    info.handle.status = 'running';
  }

  /**
   * Generate a unique ID for a subagent.
   */
  private generateId(type: SubagentType): string {
    const prefix = type === 'skill' ? 'skill' : 'sub';
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Get a subagent handle by ID.
   *
   * @param id - Subagent ID
   * @returns Handle or undefined
   */
  get(id: string): SubagentHandle | undefined {
    return this.agents.get(id)?.handle;
  }

  /**
   * Get status of a subagent.
   *
   * @param id - Subagent ID
   * @returns Status or undefined
   */
  getStatus(id: string): AgentStatus | undefined {
    return this.agents.get(id)?.handle.status;
  }

  /**
   * List all subagents, optionally filtered by status.
   *
   * @param status - Optional status filter
   * @returns Array of handles
   */
  list(status?: AgentStatus): SubagentHandle[] {
    const allHandles = Array.from(this.agents.values()).map(info => info.handle);

    if (status) {
      return allHandles.filter(h => h.status === status);
    }

    return allHandles;
  }

  /**
   * List all running subagents.
   *
   * @returns Array of running handles
   */
  listRunning(): SubagentHandle[] {
    return this.list('running');
  }

  /**
   * Terminate a subagent.
   *
   * @param id - Subagent ID
   * @returns True if terminated, false if not found
   */
  terminate(id: string): boolean {
    const info = this.agents.get(id);
    if (!info) {
      return false;
    }

    // Handle skill agent termination
    if (info.skillAgentId) {
      this.skillAgentManager.stop(info.skillAgentId);
      info.handle.status = 'stopped';
      info.handle.completedAt = new Date();
      logger.info({ id }, 'Skill subagent terminated');
      return true;
    }

    // Handle in-process agent termination
    if (info.instance) {
      if ('dispose' in info.instance && typeof info.instance.dispose === 'function') {
        try {
          info.instance.dispose();
        } catch (error) {
          logger.error({ err: error, id }, 'Error disposing subagent');
        }
      }
      info.instance = undefined;
    }

    info.handle.status = 'stopped';
    info.handle.completedAt = new Date();
    logger.info({ id }, 'Subagent terminated');

    return true;
  }

  /**
   * Terminate all running subagents.
   */
  terminateAll(): void {
    const running = this.listRunning();

    for (const handle of running) {
      this.terminate(handle.id);
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

    for (const [id, info] of this.agents) {
      const terminalStatus = ['completed', 'failed', 'stopped'].includes(info.handle.status);
      if (
        terminalStatus &&
        info.handle.completedAt &&
        now - info.handle.completedAt.getTime() > maxAge
      ) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.agents.delete(id);
    }

    // Also cleanup skill agent manager
    this.skillAgentManager.cleanup(maxAge);

    if (toDelete.length > 0) {
      logger.debug({ count: toDelete.length }, 'Cleaned up old subagent records');
    }
  }

  /**
   * Dispose of all resources.
   */
  async dispose(): Promise<void> {
    this.terminateAll();
    this.agents.clear();
    await this.skillAgentManager.dispose();
    logger.info('SubagentManager disposed');
  }
}

// Global singleton instance
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
export function initSubagentManager(callbacks: SubagentManagerCallbacks): SubagentManager {
  globalManager = new SubagentManager(callbacks);
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
