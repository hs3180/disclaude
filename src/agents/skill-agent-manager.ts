/**
 * SkillAgentManager - Manages background skill agent processes.
 *
 * Issue #455: Skill Agent System - Independent Agent processes running in background
 *
 * Features:
 * - Start/stop skill agents in background
 * - Track agent status and execution results
 * - Support scheduled execution (cron)
 * - Send notifications on completion
 *
 * @module agents/skill-agent-manager
 */

import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { findSkill } from '../skills/index.js';

const logger = createLogger('SkillAgentManager');

/**
 * Status of a skill agent.
 */
export type AgentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Configuration for starting a skill agent.
 */
export interface SkillAgentConfig {
  /** Skill name to execute */
  skillName: string;
  /** Chat ID to send notifications to */
  chatId: string;
  /** Optional template variables for the skill */
  templateVars?: Record<string, string>;
  /** Optional cron expression for scheduled execution */
  schedule?: string;
  /** Optional timeout in milliseconds */
  timeout?: number;
}

/**
 * Information about a running skill agent.
 */
export interface SkillAgentInfo {
  /** Unique agent ID */
  id: string;
  /** Skill name */
  skillName: string;
  /** Target chat ID */
  chatId: string;
  /** Current status */
  status: AgentStatus;
  /** Process ID (if running) */
  pid?: number;
  /** Start time */
  startedAt: Date;
  /** Completion time (if completed) */
  completedAt?: Date;
  /** Error message (if failed) */
  error?: string;
  /** Output from the agent */
  output?: string;
  /** Cron schedule (if scheduled) */
  schedule?: string;
}

/**
 * Callback for sending notifications.
 */
export interface NotificationCallbacks {
  /** Send a text message */
  sendMessage: (chatId: string, text: string) => Promise<void>;
  /** Send a card message */
  sendCard?: (chatId: string, card: Record<string, unknown>) => Promise<void>;
}

/**
 * Manager for background skill agent processes.
 *
 * Provides lifecycle management for skill agents running independently
 * from the main conversation flow.
 *
 * @example
 * ```typescript
 * const manager = new SkillAgentManager({
 *   sendMessage: async (chatId, text) => { ... },
 * });
 *
 * // Start a skill agent
 * const agentId = await manager.start({
 *   skillName: 'playwright-agent',
 *   chatId: 'chat-123',
 * });
 *
 * // List running agents
 * const agents = manager.list();
 *
 * // Stop an agent
 * await manager.stop(agentId);
 * ```
 */
export class SkillAgentManager {
  private agents: Map<string, SkillAgentInfo> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private callbacks: NotificationCallbacks;

  constructor(callbacks: NotificationCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Start a skill agent in the background.
   *
   * @param config - Agent configuration
   * @returns Agent ID
   */
  async start(config: SkillAgentConfig): Promise<string> {
    const agentId = `skill-${randomUUID().slice(0, 8)}`;

    // Verify skill exists
    const skillPath = await findSkill(config.skillName);
    if (!skillPath) {
      throw new Error(`Skill not found: ${config.skillName}`);
    }

    // Create agent info
    const agentInfo: SkillAgentInfo = {
      id: agentId,
      skillName: config.skillName,
      chatId: config.chatId,
      status: 'starting',
      startedAt: new Date(),
      schedule: config.schedule,
    };

    this.agents.set(agentId, agentInfo);

    // Start the skill agent process
    try {
      await this.spawnAgentProcess(agentId, config, skillPath);
    } catch (error) {
      agentInfo.status = 'failed';
      agentInfo.error = error instanceof Error ? error.message : String(error);
      agentInfo.completedAt = new Date();
      throw error;
    }

    return agentId;
  }

  /**
   * Spawn a child process to run the skill agent.
   */
  private spawnAgentProcess(
    agentId: string,
    config: SkillAgentConfig,
    skillPath: string
  ): void {
    const agentInfo = this.agents.get(agentId)!;

    // Build environment for child process
    const env = {
      ...process.env,
      SKILL_PATH: skillPath,
      SKILL_CHAT_ID: config.chatId,
      SKILL_TEMPLATE_VARS: config.templateVars ? JSON.stringify(config.templateVars) : '{}',
      SKILL_AGENT_ID: agentId,
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
        config.skillName,
        '--chat-id',
        config.chatId,
      ],
      {
        cwd: Config.getWorkspaceDir(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      }
    );

    this.processes.set(agentId, childProcess);
    agentInfo.status = 'running';
    agentInfo.pid = childProcess.pid;

    logger.info({ agentId, pid: childProcess.pid, skill: config.skillName }, 'Skill agent started');

    // Collect output
    let output = '';
    childProcess.stdout?.on('data', (data) => {
      output += data.toString();
    });

    childProcess.stderr?.on('data', (data) => {
      output += data.toString();
      logger.debug({ agentId, stderr: data.toString() }, 'Skill agent stderr');
    });

    // Handle completion
    childProcess.on('close', async (code) => {
      agentInfo.completedAt = new Date();
      agentInfo.output = output;

      if (code === 0) {
        agentInfo.status = 'completed';
        logger.info({ agentId, skill: config.skillName }, 'Skill agent completed');
        await this.notifyCompletion(agentInfo, output);
      } else if (agentInfo.status !== 'stopped') {
        agentInfo.status = 'failed';
        agentInfo.error = `Process exited with code ${code}`;
        logger.error({ agentId, code, skill: config.skillName }, 'Skill agent failed');
        await this.notifyFailure(agentInfo, output);
      }

      this.processes.delete(agentId);
    });

    // Handle timeout
    if (config.timeout) {
      setTimeout(() => {
        if (this.processes.has(agentId)) {
          this.stop(agentId);
          agentInfo.status = 'failed';
          agentInfo.error = 'Timeout exceeded';
        }
      }, config.timeout);
    }
  }

  /**
   * Send completion notification.
   */
  private async notifyCompletion(agentInfo: SkillAgentInfo, output: string): Promise<void> {
    try {
      const truncatedOutput = output.length > 2000
        ? `${output.slice(0, 2000)}\n... (输出已截断)`
        : output;

      await this.callbacks.sendMessage(
        agentInfo.chatId,
        '✅ **Skill Agent 完成**\n\n' +
        `- **Agent ID**: \`${agentInfo.id}\`\n` +
        `- **Skill**: ${agentInfo.skillName}\n` +
        `- **耗时**: ${this.getDuration(agentInfo)}\n\n` +
        `**输出:**\n\`\`\`\n${truncatedOutput}\n\`\`\``
      );
    } catch (error) {
      logger.error({ err: error, agentId: agentInfo.id }, 'Failed to send completion notification');
    }
  }

  /**
   * Send failure notification.
   */
  private async notifyFailure(agentInfo: SkillAgentInfo, output: string): Promise<void> {
    try {
      const truncatedOutput = output.length > 1000
        ? `${output.slice(0, 1000)}\n... (输出已截断)`
        : output;

      await this.callbacks.sendMessage(
        agentInfo.chatId,
        '❌ **Skill Agent 失败**\n\n' +
        `- **Agent ID**: \`${agentInfo.id}\`\n` +
        `- **Skill**: ${agentInfo.skillName}\n` +
        `- **错误**: ${agentInfo.error || '未知错误'}\n\n` +
        `**输出:**\n\`\`\`\n${truncatedOutput}\n\`\`\``
      );
    } catch (error) {
      logger.error({ err: error, agentId: agentInfo.id }, 'Failed to send failure notification');
    }
  }

  /**
   * Get duration string for an agent.
   */
  private getDuration(agentInfo: SkillAgentInfo): string {
    const end = agentInfo.completedAt || new Date();
    const durationMs = end.getTime() - agentInfo.startedAt.getTime();

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
   * Stop a running skill agent.
   *
   * @param agentId - Agent ID to stop
   * @returns True if stopped, false if not found
   */
  stop(agentId: string): boolean {
    const agentInfo = this.agents.get(agentId);
    const childProcess = this.processes.get(agentId);

    if (!agentInfo) {
      return false;
    }

    if (childProcess) {
      childProcess.kill('SIGTERM');
      agentInfo.status = 'stopped';
      agentInfo.completedAt = new Date();
      this.processes.delete(agentId);
      logger.info({ agentId }, 'Skill agent stopped');
    }

    return true;
  }

  /**
   * Get information about a specific agent.
   *
   * @param agentId - Agent ID
   * @returns Agent info or undefined
   */
  get(agentId: string): SkillAgentInfo | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get status of a specific agent.
   *
   * @param agentId - Agent ID
   * @returns Status or undefined
   */
  getStatus(agentId: string): AgentStatus | undefined {
    return this.agents.get(agentId)?.status;
  }

  /**
   * List all agents, optionally filtered by status.
   *
   * @param status - Optional status filter
   * @returns Array of agent info
   */
  list(status?: AgentStatus): SkillAgentInfo[] {
    const allAgents = Array.from(this.agents.values());

    if (status) {
      return allAgents.filter(a => a.status === status);
    }

    return allAgents;
  }

  /**
   * List running agents.
   *
   * @returns Array of running agent info
   */
  listRunning(): SkillAgentInfo[] {
    return this.list('running');
  }

  /**
   * Stop all running agents.
   */
  async stopAll(): Promise<void> {
    const runningAgents = this.listRunning();

    for (const agent of runningAgents) {
      await this.stop(agent.id);
    }

    logger.info({ count: runningAgents.length }, 'All skill agents stopped');
  }

  /**
   * Clean up completed/failed agents from memory.
   *
   * @param maxAge - Maximum age in milliseconds (default: 1 hour)
   */
  cleanup(maxAge: number = 3600000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, agent] of this.agents) {
      if (
        (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'stopped') &&
        agent.completedAt &&
        now - agent.completedAt.getTime() > maxAge
      ) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.agents.delete(id);
    }

    if (toDelete.length > 0) {
      logger.debug({ count: toDelete.length }, 'Cleaned up old agent records');
    }
  }

  /**
   * Dispose of all resources.
   */
  async dispose(): Promise<void> {
    await this.stopAll();
    this.agents.clear();
  }
}

// Global singleton instance
let globalManager: SkillAgentManager | undefined;

/**
 * Get the global SkillAgentManager instance.
 */
export function getSkillAgentManager(): SkillAgentManager | undefined {
  return globalManager;
}

/**
 * Initialize the global SkillAgentManager.
 */
export function initSkillAgentManager(callbacks: NotificationCallbacks): SkillAgentManager {
  globalManager = new SkillAgentManager(callbacks);
  return globalManager;
}

/**
 * Reset the global manager (for testing).
 */
export function resetSkillAgentManager(): void {
  globalManager = undefined;
}
