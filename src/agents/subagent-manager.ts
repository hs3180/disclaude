/**
 * SubagentManager - Unified manager for spawning and managing subagents.
 *
 * Issue #997: Unify spawn subagent methods (schedule task + skill agent)
 *
 * This module provides a unified interface for creating and managing subagents
 * across different use cases:
 * - Schedule tasks
 * - Skill agents
 * - Task agents
 *
 * Features:
 * - Unified spawn API with consistent options
 * - Lifecycle management (start, stop, status)
 * - Optional worktree isolation
 * - Unified logging and status tracking
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager({
 *   sendMessage: async (chatId, text) => { ... },
 * });
 *
 * // Spawn a skill subagent
 * const handle = await manager.spawn({
 *   type: 'skill',
 *   name: 'my-skill',
 *   chatId: 'chat-123',
 *   prompt: 'Execute the task...',
 * });
 *
 * // List running subagents
 * const running = manager.list();
 *
 * // Terminate a subagent
 * await manager.terminate(handle.id);
 * ```
 *
 * @module agents/subagent-manager
 */

import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { findSkill } from '../skills/index.js';
import { AgentFactory } from './factory.js';
import type { ChatAgent, BaseAgentConfig, AgentProvider } from './types.js';
import type { PilotCallbacks } from './pilot/index.js';

const logger = createLogger('SubagentManager');

/**
 * Type of subagent.
 */
export type SubagentType = 'schedule' | 'skill' | 'task';

/**
 * Status of a subagent.
 */
export type SubagentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Isolation mode for subagent execution.
 */
export type IsolationMode = 'none' | 'worktree';

/**
 * Options for spawning a subagent.
 */
export interface SubagentOptions {
  /** Type of subagent */
  type: SubagentType;
  /** Name (skill name for 'skill', task name for 'schedule'/'task') */
  name: string;
  /** Chat ID for message delivery */
  chatId: string;
  /** Prompt to execute */
  prompt: string;
  /** Optional template variables for skill agents */
  templateVars?: Record<string, string>;
  /** Isolation mode (default: 'none') */
  isolation?: IsolationMode;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Run in background process (default: false for in-process execution) */
  background?: boolean;
  /** Optional model override */
  model?: string;
  /** Optional provider override */
  provider?: AgentProvider;
  /** Optional API key override */
  apiKey?: string;
  /** User ID who initiated the subagent */
  userId?: string;
  /** Callback for progress updates */
  onProgress?: (message: string) => void;
}

/**
 * Handle to a spawned subagent.
 */
export interface SubagentHandle {
  /** Unique subagent ID */
  id: string;
  /** Type of subagent */
  type: SubagentType;
  /** Name */
  name: string;
  /** Chat ID */
  chatId: string;
  /** Current status */
  status: SubagentStatus;
  /** Process ID (if running in background) */
  pid?: number;
  /** Start time */
  startedAt: Date;
  /** Completion time */
  completedAt?: Date;
  /** Error message (if failed) */
  error?: string;
  /** Output from the subagent */
  output?: string;
  /** Timeout setting */
  timeout?: number;
  /** Isolation mode */
  isolation: IsolationMode;
}

/**
 * Callbacks for SubagentManager.
 */
export interface SubagentCallbacks {
  /** Send a text message */
  sendMessage: (chatId: string, text: string) => Promise<void>;
  /** Send a card message (optional) */
  sendCard?: (chatId: string, card: Record<string, unknown>) => Promise<void>;
}

/**
 * Result of subagent execution.
 */
export interface SubagentResult {
  /** Subagent ID */
  id: string;
  /** Final status */
  status: SubagentStatus;
  /** Output from execution */
  output?: string;
  /** Error message (if failed) */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Unified manager for spawning and managing subagents.
 *
 * Provides a consistent API for creating subagents across different use cases:
 * - Schedule tasks: Use type='schedule' with AgentFactory.createScheduleAgent
 * - Skill agents: Use type='skill' with SkillAgent (in-process or background)
 * - Task agents: Use type='task' with AgentFactory.createTaskAgent
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager(callbacks);
 *
 * // Spawn a skill subagent in-process
 * const handle = await manager.spawn({
 *   type: 'skill',
 *   name: 'evaluator',
 *   chatId: 'chat-123',
 *   prompt: 'Evaluate the task...',
 * });
 *
 * // Spawn a schedule subagent
 * const handle = await manager.spawn({
 *   type: 'schedule',
 *   name: 'daily-report',
 *   chatId: 'chat-123',
 *   prompt: 'Generate daily report...',
 * });
 * ```
 */
export class SubagentManager {
  private subagents: Map<string, SubagentHandle> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private inProcessAgents: Map<string, ChatAgent> = new Map();
  private callbacks: SubagentCallbacks;

  constructor(callbacks: SubagentCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Spawn a subagent with the given options.
   *
   * @param options - Subagent options
   * @returns Handle to the spawned subagent
   */
  async spawn(options: SubagentOptions): Promise<SubagentHandle> {
    const subagentId = this.generateId(options.type);

    // Create handle
    const handle: SubagentHandle = {
      id: subagentId,
      type: options.type,
      name: options.name,
      chatId: options.chatId,
      status: 'starting',
      startedAt: new Date(),
      timeout: options.timeout,
      isolation: options.isolation || 'none',
    };

    this.subagents.set(subagentId, handle);

    try {
      if (options.background && options.type === 'skill') {
        // Spawn in background process
        await this.spawnBackgroundProcess(subagentId, options);
      } else {
        // Execute in-process
        await this.executeInProcess(subagentId, options);
      }
    } catch (error) {
      handle.status = 'failed';
      handle.error = error instanceof Error ? error.message : String(error);
      handle.completedAt = new Date();
      throw error;
    }

    return handle;
  }

  /**
   * Generate a unique ID for a subagent.
   */
  private generateId(type: SubagentType): string {
    const prefix = type === 'schedule' ? 'sched' : type === 'skill' ? 'skill' : 'task';
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Execute subagent in-process.
   */
  private async executeInProcess(
    subagentId: string,
    options: SubagentOptions
  ): Promise<void> {
    const handle = this.subagents.get(subagentId)!;
    const pilotCallbacks: PilotCallbacks = {
      sendMessage: this.callbacks.sendMessage,
      sendCard: this.callbacks.sendCard,
      sendFile: async (chatId: string, filePath: string) => {
        // Default implementation - can be extended
        await this.callbacks.sendMessage(chatId, `File: ${filePath}`);
      },
    };

    let agent: ChatAgent | undefined;

    try {
      // Create appropriate agent based on type
      const agentOptions = {
        model: options.model,
        provider: options.provider,
        apiKey: options.apiKey,
      };

      switch (options.type) {
        case 'schedule':
          agent = AgentFactory.createScheduleAgent(
            options.chatId,
            pilotCallbacks,
            agentOptions
          );
          break;
        case 'task':
          agent = AgentFactory.createTaskAgent(
            options.chatId,
            pilotCallbacks,
            agentOptions
          );
          break;
        case 'skill':
          // For skill type, we use SkillAgent directly
          agent = AgentFactory.createScheduleAgent(
            options.chatId,
            pilotCallbacks,
            agentOptions
          );
          break;
      }

      this.inProcessAgents.set(subagentId, agent);
      handle.status = 'running';

      logger.info({ subagentId, type: options.type, name: options.name }, 'Subagent started');

      // Execute the agent
      await agent.executeOnce(
        options.chatId,
        options.prompt,
        undefined,
        options.userId
      );

      handle.status = 'completed';
      handle.completedAt = new Date();
      logger.info({ subagentId }, 'Subagent completed');

    } catch (error) {
      handle.status = 'failed';
      handle.error = error instanceof Error ? error.message : String(error);
      handle.completedAt = new Date();
      logger.error({ err: error, subagentId }, 'Subagent failed');
      throw error;
    } finally {
      if (agent) {
        try {
          agent.dispose();
        } catch (err) {
          logger.error({ err, subagentId }, 'Error disposing agent');
        }
      }
      this.inProcessAgents.delete(subagentId);
    }
  }

  /**
   * Spawn a background process for skill execution.
   */
  private async spawnBackgroundProcess(
    subagentId: string,
    options: SubagentOptions
  ): Promise<void> {
    const handle = this.subagents.get(subagentId)!;

    // Verify skill exists
    const skillPath = await findSkill(options.name);
    if (!skillPath) {
      throw new Error(`Skill not found: ${options.name}`);
    }

    // Build environment for child process
    const env = {
      ...process.env,
      SKILL_PATH: skillPath,
      SKILL_CHAT_ID: options.chatId,
      SKILL_TEMPLATE_VARS: options.templateVars ? JSON.stringify(options.templateVars) : '{}',
      SKILL_AGENT_ID: subagentId,
    };

    // Spawn node process to run the skill
    const childProcess = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        require.resolve('../cli-entry.js'),
        'skill',
        'run',
        options.name,
        '--chat-id',
        options.chatId,
      ],
      {
        cwd: Config.getWorkspaceDir(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      }
    );

    this.processes.set(subagentId, childProcess);
    handle.status = 'running';
    handle.pid = childProcess.pid;

    logger.info({ subagentId, pid: childProcess.pid, skill: options.name }, 'Background skill agent started');

    // Collect output
    let output = '';
    childProcess.stdout?.on('data', (data) => {
      output += data.toString();
      options.onProgress?.(data.toString());
    });

    childProcess.stderr?.on('data', (data) => {
      output += data.toString();
      logger.debug({ subagentId, stderr: data.toString() }, 'Subagent stderr');
    });

    // Handle completion
    childProcess.on('close', async (code) => {
      handle.completedAt = new Date();
      handle.output = output;

      if (code === 0) {
        handle.status = 'completed';
        logger.info({ subagentId, skill: options.name }, 'Background subagent completed');
        await this.notifyCompletion(handle, output);
      } else if (handle.status !== 'stopped') {
        handle.status = 'failed';
        handle.error = `Process exited with code ${code}`;
        logger.error({ subagentId, code, skill: options.name }, 'Background subagent failed');
        await this.notifyFailure(handle, output);
      }

      this.processes.delete(subagentId);
    });

    // Handle timeout
    if (options.timeout) {
      setTimeout(() => {
        if (this.processes.has(subagentId)) {
          this.terminate(subagentId);
          handle.status = 'failed';
          handle.error = 'Timeout exceeded';
        }
      }, options.timeout);
    }
  }

  /**
   * Send completion notification.
   */
  private async notifyCompletion(handle: SubagentHandle, output: string): Promise<void> {
    try {
      const truncatedOutput = output.length > 2000
        ? `${output.slice(0, 2000)}\n... (output truncated)`
        : output;

      await this.callbacks.sendMessage(
        handle.chatId,
        '✅ **Subagent Completed**\n\n' +
        `- **ID**: \`${handle.id}\`\n` +
        `- **Type**: ${handle.type}\n` +
        `- **Name**: ${handle.name}\n` +
        `- **Duration**: ${this.getDuration(handle)}\n\n` +
        `**Output:**\n\`\`\`\n${truncatedOutput}\n\`\`\``
      );
    } catch (error) {
      logger.error({ err: error, subagentId: handle.id }, 'Failed to send completion notification');
    }
  }

  /**
   * Send failure notification.
   */
  private async notifyFailure(handle: SubagentHandle, output: string): Promise<void> {
    try {
      const truncatedOutput = output.length > 1000
        ? `${output.slice(0, 1000)}\n... (output truncated)`
        : output;

      await this.callbacks.sendMessage(
        handle.chatId,
        '❌ **Subagent Failed**\n\n' +
        `- **ID**: \`${handle.id}\`\n` +
        `- **Type**: ${handle.type}\n` +
        `- **Name**: ${handle.name}\n` +
        `- **Error**: ${handle.error || 'Unknown error'}\n\n` +
        `**Output:**\n\`\`\`\n${truncatedOutput}\n\`\`\``
      );
    } catch (error) {
      logger.error({ err: error, subagentId: handle.id }, 'Failed to send failure notification');
    }
  }

  /**
   * Get duration string for a subagent.
   */
  private getDuration(handle: SubagentHandle): string {
    const end = handle.completedAt || new Date();
    const durationMs = end.getTime() - handle.startedAt.getTime();

    if (durationMs < 1000) {
      return `${durationMs}ms`;
    } else if (durationMs < 60000) {
      return `${Math.round(durationMs / 1000)}s`;
    } else {
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.round((durationMs % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
  }

  /**
   * Get a subagent handle by ID.
   *
   * @param id - Subagent ID
   * @returns Handle or undefined
   */
  get(id: string): SubagentHandle | undefined {
    return this.subagents.get(id);
  }

  /**
   * Get status of a subagent.
   *
   * @param id - Subagent ID
   * @returns Status or undefined
   */
  getStatus(id: string): SubagentStatus | undefined {
    return this.subagents.get(id)?.status;
  }

  /**
   * List all subagents, optionally filtered by status.
   *
   * @param status - Optional status filter
   * @returns Array of subagent handles
   */
  list(status?: SubagentStatus): SubagentHandle[] {
    const allHandles = Array.from(this.subagents.values());

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
   * Terminate a running subagent.
   *
   * @param id - Subagent ID to terminate
   * @returns True if terminated, false if not found
   */
  terminate(id: string): boolean {
    const handle = this.subagents.get(id);
    const childProcess = this.processes.get(id);
    const inProcessAgent = this.inProcessAgents.get(id);

    if (!handle) {
      return false;
    }

    // Terminate background process
    if (childProcess) {
      childProcess.kill('SIGTERM');
      handle.status = 'stopped';
      handle.completedAt = new Date();
      this.processes.delete(id);
      logger.info({ subagentId: id }, 'Background subagent terminated');
    }

    // Terminate in-process agent
    if (inProcessAgent) {
      try {
        inProcessAgent.dispose();
        handle.status = 'stopped';
        handle.completedAt = new Date();
        this.inProcessAgents.delete(id);
        logger.info({ subagentId: id }, 'In-process subagent terminated');
      } catch (err) {
        logger.error({ err, subagentId: id }, 'Error terminating in-process subagent');
      }
    }

    return true;
  }

  /**
   * Terminate all running subagents.
   */
  async terminateAll(): Promise<void> {
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

    for (const [id, handle] of this.subagents) {
      if (
        (handle.status === 'completed' || handle.status === 'failed' || handle.status === 'stopped') &&
        handle.completedAt &&
        now - handle.completedAt.getTime() > maxAge
      ) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.subagents.delete(id);
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
    this.subagents.clear();
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
export function initSubagentManager(callbacks: SubagentCallbacks): SubagentManager {
  globalManager = new SubagentManager(callbacks);
  return globalManager;
}

/**
 * Reset the global manager (for testing).
 */
export function resetSubagentManager(): void {
  globalManager = undefined;
}
