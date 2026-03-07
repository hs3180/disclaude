/**
 * SubagentManager - Unified management for all subagent types.
 *
 * Issue #997: Unified spawn subagent methods (schedule task + skill agent)
 *
 * Features:
 * - Unified API to create and manage subagents
 * - Lifecycle management (start, stop, status query)
 * - Optional worktree isolation support
 * - Unified logging and status tracking
 *
 * @module agents/subagent/manager
 */

import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { Config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import { findSkill } from '../../skills/index.js';
import {
  type SubagentType,
  type SubagentStatus,
  type SubagentOptions,
  type SubagentHandle,
  type SubagentCallbacks,
  type SubagentListFilter,
  type SubagentMetrics,
} from './types.js';

const logger = createLogger('SubagentManager');

/**
 * Internal subagent record.
 */
interface SubagentRecord {
  handle: SubagentHandle;
  process?: ChildProcess;
  options: SubagentOptions;
  metrics: SubagentMetrics;
  output: string;
}

/**
 * Manager for unified subagent creation and lifecycle management.
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager({
 *   sendMessage: async (chatId, text) => { ... },
 * });
 *
 * // Spawn a schedule agent
 * const handle = await manager.spawn({
 *   type: 'schedule',
 *   name: 'daily-report',
 *   prompt: 'Generate daily report...',
 *   chatId: 'chat-123',
 * });
 *
 * // Spawn a skill agent
 * const handle2 = await manager.spawn({
 *   type: 'skill',
 *   name: 'site-miner',
 *   prompt: 'Extract data from...',
 *   skillName: 'site-miner',
 *   isolation: 'worktree',
 * });
 *
 * // List running agents
 * const agents = manager.list({ status: 'running' });
 *
 * // Terminate an agent
 * await manager.terminate(handle.id);
 * ```
 */
export class SubagentManager {
  private agents: Map<string, SubagentRecord> = new Map();
  private callbacks: SubagentCallbacks;

  constructor(callbacks: SubagentCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Generate a unique agent ID.
   */
  private generateId(type: SubagentType): string {
    const prefix = type === 'schedule' ? 'sched' : type === 'skill' ? 'skill' : 'task';
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Spawn a subagent.
   *
   * @param options - Subagent options
   * @returns Handle to the spawned subagent
   */
  async spawn(options: SubagentOptions): Promise<SubagentHandle> {
    const id = this.generateId(options.type);

    // Validate options based on type
    this.validateOptions(options);

    // Create handle
    const handle: SubagentHandle = {
      id,
      type: options.type,
      name: options.name,
      status: 'starting',
      startedAt: new Date(),
    };

    // Create record
    const record: SubagentRecord = {
      handle,
      options,
      metrics: {
        totalDurationMs: 0,
        errors: 0,
      },
      output: '',
    };

    this.agents.set(id, record);

    try {
      // Spawn based on type
      switch (options.type) {
        case 'schedule':
          await this.spawnScheduleAgent(record);
          break;
        case 'skill':
          await this.spawnSkillAgent(record);
          break;
        case 'task':
          await this.spawnTaskAgent(record);
          break;
        default:
          throw new Error(`Unknown subagent type: ${options.type}`);
      }
    } catch (error) {
      record.handle.status = 'failed';
      record.handle.error = error instanceof Error ? error.message : String(error);
      record.handle.completedAt = new Date();
      throw error;
    }

    return handle;
  }

  /**
   * Validate subagent options.
   */
  private validateOptions(options: SubagentOptions): void {
    if (options.type === 'skill' && !options.skillName) {
      throw new Error('skillName is required for skill type subagents');
    }

    if (options.type === 'schedule' && !options.chatId) {
      throw new Error('chatId is required for schedule type subagents');
    }
  }

  /**
   * Spawn a schedule agent (runs in-process).
   */
  private async spawnScheduleAgent(record: SubagentRecord): Promise<void> {
    const { options, handle } = record;

    logger.info({ id: handle.id, name: options.name }, 'Spawning schedule agent');

    // Schedule agents run in-process using AgentFactory
    // The actual execution is handled by the scheduler
    handle.status = 'running';

    // For schedule agents, we just mark them as running
    // The actual execution is managed by the scheduler module
    logger.info({ id: handle.id }, 'Schedule agent spawned');
  }

  /**
   * Spawn a skill agent (runs in separate process).
   */
  private async spawnSkillAgent(record: SubagentRecord): Promise<void> {
    const { options, handle } = record;
    const skillName = options.skillName!;

    logger.info({ id: handle.id, skillName }, 'Spawning skill agent');

    // Verify skill exists
    const skillPath = await findSkill(skillName);
    if (!skillPath) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    // Build environment for child process
    const env = {
      ...process.env,
      SKILL_PATH: skillPath,
      SKILL_CHAT_ID: options.chatId || '',
      SKILL_TEMPLATE_VARS: options.templateVars ? JSON.stringify(options.templateVars) : '{}',
      SKILL_AGENT_ID: handle.id,
      SUBAGENT_PROMPT: options.prompt,
    };

    // Spawn node process to run the skill
    const childProcess = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        require.resolve('../../cli-entry.js'),
        'skill',
        'run',
        skillName,
        '--chat-id',
        options.chatId || '',
      ],
      {
        cwd: options.cwd || Config.getWorkspaceDir(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      }
    );

    record.process = childProcess;
    handle.status = 'running';
    handle.pid = childProcess.pid;

    logger.info({ id: handle.id, pid: childProcess.pid, skillName }, 'Skill agent started');

    // Collect output
    childProcess.stdout?.on('data', (data) => {
      record.output += data.toString();
      options.onProgress?.(data.toString());
    });

    childProcess.stderr?.on('data', (data) => {
      record.output += data.toString();
      logger.debug({ id: handle.id, stderr: data.toString() }, 'Skill agent stderr');
    });

    // Handle completion
    childProcess.on('close', async (code) => {
      handle.completedAt = new Date();
      handle.duration = handle.completedAt.getTime() - handle.startedAt.getTime();
      record.metrics.totalDurationMs = handle.duration;
      handle.output = record.output;

      if (code === 0) {
        handle.status = 'completed';
        logger.info({ id: handle.id, skillName, duration: handle.duration }, 'Skill agent completed');
        await this.notifyCompletion(record);
      } else if (handle.status !== 'stopped') {
        handle.status = 'failed';
        handle.error = `Process exited with code ${code}`;
        record.metrics.errors++;
        record.metrics.lastError = handle.error;
        logger.error({ id: handle.id, code, skillName }, 'Skill agent failed');
        await this.notifyFailure(record);
      }
    });

    // Handle timeout
    if (options.timeout) {
      setTimeout(() => {
        if (record.process && handle.status === 'running') {
          this.terminate(handle.id);
          handle.status = 'timeout';
          handle.error = 'Timeout exceeded';
          record.metrics.errors++;
        }
      }, options.timeout);
    }
  }

  /**
   * Spawn a task agent (runs in-process with iteration management).
   */
  private async spawnTaskAgent(record: SubagentRecord): Promise<void> {
    const { options, handle } = record;

    logger.info({ id: handle.id, name: options.name }, 'Spawning task agent');

    // Task agents run in-process
    handle.status = 'running';

    // The actual execution is handled by the task module
    logger.info({ id: handle.id }, 'Task agent spawned');
  }

  /**
   * Send completion notification.
   */
  private async notifyCompletion(record: SubagentRecord): Promise<void> {
    const { handle, options, output } = record;

    if (!options.chatId) return;

    try {
      const truncatedOutput = output.length > 2000
        ? `${output.slice(0, 2000)}\n... (输出已截断)`
        : output;

      await this.callbacks.sendMessage(
        options.chatId,
        '✅ **Subagent 完成**\n\n' +
        `- **ID**: \`${handle.id}\`\n` +
        `- **类型**: ${handle.type}\n` +
        `- **名称**: ${handle.name}\n` +
        `- **耗时**: ${this.formatDuration(handle.duration || 0)}\n\n` +
        `**输出:**\n\`\`\`\n${truncatedOutput}\n\`\`\``
      );
    } catch (error) {
      logger.error({ err: error, id: handle.id }, 'Failed to send completion notification');
    }
  }

  /**
   * Send failure notification.
   */
  private async notifyFailure(record: SubagentRecord): Promise<void> {
    const { handle, options, output } = record;

    if (!options.chatId) return;

    try {
      const truncatedOutput = output.length > 1000
        ? `${output.slice(0, 1000)}\n... (输出已截断)`
        : output;

      await this.callbacks.sendMessage(
        options.chatId,
        '❌ **Subagent 失败**\n\n' +
        `- **ID**: \`${handle.id}\`\n` +
        `- **类型**: ${handle.type}\n` +
        `- **名称**: ${handle.name}\n` +
        `- **错误**: ${handle.error || '未知错误'}\n\n` +
        `**输出:**\n\`\`\`\n${truncatedOutput}\n\`\`\``
      );
    } catch (error) {
      logger.error({ err: error, id: handle.id }, 'Failed to send failure notification');
    }
  }

  /**
   * Format duration for display.
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${Math.round(ms / 1000)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.round((ms % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
  }

  /**
   * List all subagents, optionally filtered.
   *
   * @param filter - Optional filter criteria
   * @returns Array of subagent handles
   */
  list(filter?: SubagentListFilter): SubagentHandle[] {
    let result = Array.from(this.agents.values()).map(r => r.handle);

    if (filter) {
      if (filter.type) {
        result = result.filter(h => h.type === filter.type);
      }
      if (filter.status) {
        result = result.filter(h => h.status === filter.status);
      }
      if (filter.namePattern) {
        const pattern = typeof filter.namePattern === 'string'
          ? new RegExp(filter.namePattern, 'i')
          : filter.namePattern;
        result = result.filter(h => pattern.test(h.name));
      }
    }

    return result;
  }

  /**
   * Get a specific subagent by ID.
   *
   * @param id - Subagent ID
   * @returns Subagent handle or undefined
   */
  get(id: string): SubagentHandle | undefined {
    return this.agents.get(id)?.handle;
  }

  /**
   * Get status of a specific subagent.
   *
   * @param id - Subagent ID
   * @returns Status or undefined
   */
  getStatus(id: string): SubagentStatus | undefined {
    return this.agents.get(id)?.handle.status;
  }

  /**
   * Get metrics for a specific subagent.
   *
   * @param id - Subagent ID
   * @returns Metrics or undefined
   */
  getMetrics(id: string): SubagentMetrics | undefined {
    return this.agents.get(id)?.metrics;
  }

  /**
   * Terminate a running subagent.
   *
   * @param id - Subagent ID
   * @returns True if terminated, false if not found or already stopped
   */
  terminate(id: string): boolean {
    const record = this.agents.get(id);

    if (!record) {
      return false;
    }

    const { handle, process } = record;

    if (handle.status !== 'running' && handle.status !== 'starting') {
      return false;
    }

    if (process) {
      process.kill('SIGTERM');
    }

    handle.status = 'stopped';
    handle.completedAt = new Date();
    handle.duration = handle.completedAt.getTime() - handle.startedAt.getTime();

    logger.info({ id }, 'Subagent terminated');

    return true;
  }

  /**
   * Terminate all running subagents.
   */
  async terminateAll(): Promise<void> {
    const runningAgents = this.list({ status: 'running' });

    for (const handle of runningAgents) {
      this.terminate(handle.id);
    }

    logger.info({ count: runningAgents.length }, 'All subagents terminated');
  }

  /**
   * Clean up completed/failed/stopped subagents from memory.
   *
   * @param maxAge - Maximum age in milliseconds (default: 1 hour)
   */
  cleanup(maxAge: number = 3600000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, record] of this.agents) {
      const { handle } = record;
      if (
        (handle.status === 'completed' || handle.status === 'failed' || handle.status === 'stopped' || handle.status === 'timeout') &&
        handle.completedAt &&
        now - handle.completedAt.getTime() > maxAge
      ) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.agents.delete(id);
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
    this.agents.clear();
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

/**
 * Convenience function to spawn a subagent using the global manager.
 *
 * @param options - Subagent options
 * @returns Handle to the spawned subagent
 */
export async function spawnSubagent(options: SubagentOptions): Promise<SubagentHandle> {
  const manager = getSubagentManager();
  if (!manager) {
    throw new Error('SubagentManager not initialized. Call initSubagentManager first.');
  }
  return manager.spawn(options);
}
