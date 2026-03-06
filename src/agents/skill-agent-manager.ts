/**
 * SkillAgentManager - Manages background execution of SkillAgents.
 *
 * This module implements the Skill Agent system as described in Issue #455:
 * - Background execution of skill agents
 * - Process lifecycle management
 * - Result notification via Feishu
 *
 * @module agents/skill-agent-manager
 */

import { v4 as uuidv4 } from 'uuid';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { SkillAgent } from './skill-agent.js';
import { findSkill, listSkills, type DiscoveredSkill } from '../skills/finder.js';
import type { BaseAgentConfig } from './types.js';

const logger = createLogger('SkillAgentManager');

/**
 * Status of a running skill agent.
 */
export type SkillAgentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Information about a running skill agent.
 */
export interface RunningSkillAgent {
  /** Unique identifier for this agent instance */
  id: string;
  /** Skill name */
  skillName: string;
  /** Path to skill file */
  skillPath: string;
  /** Chat ID for result notification */
  chatId: string;
  /** Current status */
  status: SkillAgentStatus;
  /** When the agent was started */
  startedAt: Date;
  /** When the agent completed (if applicable) */
  completedAt?: Date;
  /** Error message if failed */
  error?: string;
  /** Result summary */
  result?: string;
  /** Abort controller for cancellation */
  abortController: AbortController;
}

/**
 * Options for starting a skill agent.
 */
export interface StartSkillAgentOptions {
  /** Skill name to run */
  skillName: string;
  /** Chat ID for result notification */
  chatId: string;
  /** Template variables for skill execution */
  templateVars?: Record<string, string>;
  /** Input for the skill */
  input?: string;
  /** Callback to send messages */
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

/**
 * SkillAgentManager - Manages background execution of SkillAgents.
 *
 * Features:
 * - Start/stop skill agents
 * - Track running agents
 * - Send result notifications
 * - Support cancellation
 *
 * @example
 * ```typescript
 * const manager = new SkillAgentManager(agentConfig);
 *
 * // Start a skill agent
 * const agentId = await manager.start({
 *   skillName: 'site-miner',
 *   chatId: 'oc_xxx',
 *   sendMessage: async (chatId, text) => { ... },
 * });
 *
 * // List running agents
 * const running = manager.listRunning();
 *
 * // Stop an agent
 * await manager.stop(agentId);
 * ```
 */
export class SkillAgentManager {
  private runningAgents = new Map<string, RunningSkillAgent>();
  private agentConfig: BaseAgentConfig;

  constructor(agentConfig: BaseAgentConfig) {
    this.agentConfig = agentConfig;
  }

  /**
   * Start a skill agent in the background.
   *
   * @param options - Start options
   * @returns Agent ID
   */
  async start(options: StartSkillAgentOptions): Promise<string> {
    const { skillName, chatId, templateVars, input, sendMessage } = options;

    // Find the skill file
    const skillPath = await findSkill(skillName);
    if (!skillPath) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    // Create agent ID
    const agentId = uuidv4();

    // Create abort controller for cancellation
    const abortController = new AbortController();

    // Create running agent record
    const runningAgent: RunningSkillAgent = {
      id: agentId,
      skillName,
      skillPath,
      chatId,
      status: 'starting',
      startedAt: new Date(),
      abortController,
    };

    // Register the agent
    this.runningAgents.set(agentId, runningAgent);

    logger.info({ agentId, skillName, chatId }, 'Starting skill agent');

    // Start execution in background
    this.executeInBackground(runningAgent, { templateVars, input, sendMessage })
      .catch(error => {
        logger.error({ agentId, error }, 'Skill agent execution failed');
      });

    return agentId;
  }

  /**
   * Execute a skill agent in the background.
   */
  private async executeInBackground(
    runningAgent: RunningSkillAgent,
    options: {
      templateVars?: Record<string, string>;
      input?: string;
      sendMessage: (chatId: string, text: string) => Promise<void>;
    }
  ): Promise<void> {
    const { templateVars, input, sendMessage } = options;
    const { id: agentId, skillPath, chatId, abortController } = runningAgent;

    try {
      // Update status
      runningAgent.status = 'running';

      // Send start notification
      await sendMessage(chatId, `🎯 **Skill Agent Started**\n\nSkill: \`${runningAgent.skillName}\`\nAgent ID: \`${agentId}\`\n\nExecuting in background...`);

      // Create skill agent
      const agent = new SkillAgent(this.agentConfig, skillPath);
      agent.initialize();

      // Collect results
      let resultContent = '';
      const abortSignal = abortController.signal;

      // Execute with template variables or input
      const generator = templateVars
        ? agent.executeWithContext({ templateVars })
        : agent.execute(input || '');

      for await (const message of generator) {
        // Check for cancellation
        if (abortSignal.aborted) {
          runningAgent.status = 'cancelled';
          runningAgent.completedAt = new Date();
          await sendMessage(chatId, `⏹️ **Skill Agent Cancelled**\n\nSkill: \`${runningAgent.skillName}\`\nAgent ID: \`${agentId}\``);
          agent.dispose();
          return;
        }

        // Collect result content
        if (message.content) {
          resultContent += message.content + '\n';
        }
      }

      // Mark as completed
      runningAgent.status = 'completed';
      runningAgent.completedAt = new Date();
      runningAgent.result = resultContent.slice(0, 1000); // Truncate for storage

      // Send completion notification
      const truncatedResult = resultContent.length > 2000
        ? resultContent.slice(0, 2000) + '\n\n... (truncated)'
        : resultContent;

      await sendMessage(chatId, `✅ **Skill Agent Completed**\n\nSkill: \`${runningAgent.skillName}\`\nAgent ID: \`${agentId}\`\nDuration: ${this.formatDuration(runningAgent.startedAt, runningAgent.completedAt)}\n\n**Result:**\n${truncatedResult}`);

      // Dispose agent
      agent.dispose();

      logger.info({ agentId, skillName: runningAgent.skillName }, 'Skill agent completed');

    } catch (error) {
      // Mark as failed
      runningAgent.status = 'failed';
      runningAgent.completedAt = new Date();
      runningAgent.error = error instanceof Error ? error.message : String(error);

      // Send error notification
      await sendMessage(chatId, `❌ **Skill Agent Failed**\n\nSkill: \`${runningAgent.skillName}\`\nAgent ID: \`${agentId}\`\nError: ${runningAgent.error}`);

      logger.error({ agentId, error: runningAgent.error }, 'Skill agent failed');
    }
  }

  /**
   * Stop a running skill agent.
   *
   * @param agentId - Agent ID to stop
   * @returns True if stopped, false if not found
   */
  async stop(agentId: string): Promise<boolean> {
    const runningAgent = this.runningAgents.get(agentId);
    if (!runningAgent) {
      return false;
    }

    if (runningAgent.status !== 'running' && runningAgent.status !== 'starting') {
      return false;
    }

    // Abort the execution
    runningAgent.abortController.abort();

    logger.info({ agentId }, 'Skill agent stop requested');

    return true;
  }

  /**
   * Get status of a running skill agent.
   *
   * @param agentId - Agent ID
   * @returns Agent info or undefined if not found
   */
  getStatus(agentId: string): RunningSkillAgent | undefined {
    return this.runningAgents.get(agentId);
  }

  /**
   * List all running skill agents.
   *
   * @param chatId - Optional chat ID to filter by
   * @returns Array of running agents
   */
  listRunning(chatId?: string): RunningSkillAgent[] {
    const agents = Array.from(this.runningAgents.values());

    if (chatId) {
      return agents.filter(a => a.chatId === chatId);
    }

    return agents;
  }

  /**
   * List all available skills.
   *
   * @returns Array of discovered skills
   */
  async listAvailableSkills(): Promise<DiscoveredSkill[]> {
    return listSkills();
  }

  /**
   * Clean up completed/failed agents older than the specified age.
   *
   * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
   */
  cleanup(maxAgeMs: number = 3600000): void {
    const now = Date.now();

    for (const [agentId, agent] of this.runningAgents.entries()) {
      if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') {
        const completedAt = agent.completedAt?.getTime() ?? agent.startedAt.getTime();
        if (now - completedAt > maxAgeMs) {
          this.runningAgents.delete(agentId);
          logger.debug({ agentId }, 'Cleaned up old agent record');
        }
      }
    }
  }

  /**
   * Format duration between two dates.
   */
  private formatDuration(start: Date, end?: Date): string {
    const endTime = end?.getTime() ?? Date.now();
    const durationMs = endTime - start.getTime();

    if (durationMs < 1000) {
      return `${durationMs}ms`;
    } else if (durationMs < 60000) {
      return `${(durationMs / 1000).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.floor((durationMs % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
  }
}

// Singleton instance (lazy initialization)
let managerInstance: SkillAgentManager | null = null;

/**
 * Get the singleton SkillAgentManager instance.
 *
 * @returns SkillAgentManager instance
 */
export function getSkillAgentManager(): SkillAgentManager {
  if (!managerInstance) {
    const agentConfig = Config.getAgentConfig();
    managerInstance = new SkillAgentManager({
      apiKey: agentConfig.apiKey,
      model: agentConfig.model,
      provider: agentConfig.provider,
      apiBaseUrl: agentConfig.apiBaseUrl,
      permissionMode: 'bypassPermissions',
    });
  }
  return managerInstance;
}
