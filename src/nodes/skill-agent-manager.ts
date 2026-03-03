/**
 * SkillAgentManager - Manages background skill agent execution.
 *
 * Features:
 * - Start skill agents with unique IDs
 * - Track running agents
 * - Send results to chat on completion
 * - Support cancellation
 *
 * Issue #455: Skill Agent system
 *
 * @module nodes/skill-agent-manager
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import { AgentFactory } from '../agents/index.js';
import { findSkill, listSkills, type DiscoveredSkill } from '../skills/index.js';
import type { AgentMessage } from '../types/agent.js';

const logger = createLogger('SkillAgentManager');

/**
 * Status of a skill agent.
 */
export type SkillAgentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Information about a running skill agent.
 */
export interface RunningSkillAgent {
  /** Unique agent instance ID */
  id: string;
  /** Skill name */
  skillName: string;
  /** Target chat ID for results */
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
  /** Target chat ID for results */
  chatId: string;
  /** Optional input prompt for the skill */
  input?: string;
  /** Template variables for skill execution */
  templateVars?: Record<string, string>;
}

/**
 * Callbacks for skill agent manager.
 */
export interface SkillAgentManagerCallbacks {
  /** Send a text message */
  sendMessage: (chatId: string, text: string) => Promise<void>;
  /** Send a card message */
  sendCard: (chatId: string, card: Record<string, unknown>) => Promise<void>;
}

/**
 * Configuration for SkillAgentManager.
 */
export interface SkillAgentManagerConfig {
  /** Callbacks for sending results */
  callbacks: SkillAgentManagerCallbacks;
}

/**
 * SkillAgentManager - Manages background skill agent execution.
 *
 * @example
 * ```typescript
 * const manager = new SkillAgentManager({
 *   callbacks: {
 *     sendMessage: async (chatId, text) => { ... },
 *     sendCard: async (chatId, card) => { ... },
 *   },
 * });
 *
 * // Start a skill agent
 * const agentId = await manager.start({
 *   skillName: 'site-miner',
 *   chatId: 'oc_xxx',
 *   input: 'Extract product list from https://example.com',
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
  private readonly callbacks: SkillAgentManagerCallbacks;
  private readonly runningAgents = new Map<string, RunningSkillAgent>();

  constructor(config: SkillAgentManagerConfig) {
    this.callbacks = config.callbacks;
  }

  /**
   * List all available skills.
   *
   * @returns Array of discovered skills
   */
  async listAvailableSkills(): Promise<DiscoveredSkill[]> {
    return await listSkills();
  }

  /**
   * Check if a skill exists.
   *
   * @param skillName - Skill name to check
   * @returns True if skill exists
   */
  async skillExists(skillName: string): Promise<boolean> {
    const skillPath = await findSkill(skillName);
    return skillPath !== null;
  }

  /**
   * Start a skill agent in the background.
   *
   * @param options - Start options
   * @returns Agent instance ID
   */
  async start(options: StartSkillAgentOptions): Promise<string> {
    const { skillName, chatId, input, templateVars } = options;

    // Check if skill exists
    const skillPath = await findSkill(skillName);
    if (!skillPath) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    // Generate unique ID
    const agentId = `skill-${skillName}-${uuidv4().slice(0, 8)}`;

    // Create abort controller for cancellation
    const abortController = new AbortController();

    // Create running agent record
    const runningAgent: RunningSkillAgent = {
      id: agentId,
      skillName,
      chatId,
      status: 'running',
      startedAt: new Date(),
      abortController,
    };

    this.runningAgents.set(agentId, runningAgent);

    // Start execution in background
    this.executeSkillAsync(agentId, skillName, chatId, input, templateVars, abortController.signal)
      .catch((error) => {
        logger.error({ err: error, agentId, skillName }, 'Skill agent execution failed');
      });

    logger.info({ agentId, skillName, chatId }, 'Skill agent started');

    return agentId;
  }

  /**
   * Execute a skill agent asynchronously.
   */
  private async executeSkillAsync(
    agentId: string,
    skillName: string,
    chatId: string,
    input?: string,
    _templateVars?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<void> {
    const agent = this.runningAgents.get(agentId);
    if (!agent) {
      return;
    }

    try {
      // Create skill agent
      const skillAgent = await AgentFactory.createSkillAgent(skillName);

      // Collect results
      const results: AgentMessage[] = [];

      // Build input - use provided input or empty string for skill execution
      const executeInput = input || '';

      // Execute skill
      for await (const message of skillAgent.execute(executeInput)) {
        // Check for cancellation
        if (signal?.aborted) {
          agent.status = 'cancelled';
          agent.completedAt = new Date();
          logger.info({ agentId, skillName }, 'Skill agent cancelled');
          await this.notifyCancellation(chatId, agentId, skillName);
          return;
        }

        results.push(message);
      }

      // Mark as completed
      agent.status = 'completed';
      agent.completedAt = new Date();

      // Extract result summary
      const lastMessage = results[results.length - 1];
      // Handle content that could be string or ContentBlock[]
      const content = lastMessage?.content;
      agent.result = typeof content === 'string' ? content : content ? JSON.stringify(content) : 'Completed with no output';

      logger.info({ agentId, skillName, resultCount: results.length }, 'Skill agent completed');

      // Send result notification
      await this.notifyCompletion(chatId, agentId, skillName, results);

    } catch (error) {
      const err = error as Error;

      // Check if cancelled during error
      if (signal?.aborted) {
        agent.status = 'cancelled';
        agent.completedAt = new Date();
        return;
      }

      agent.status = 'failed';
      agent.completedAt = new Date();
      agent.error = err.message;

      logger.error({ err, agentId, skillName }, 'Skill agent failed');

      // Send error notification
      await this.notifyError(chatId, agentId, skillName, err.message);
    }
  }

  /**
   * Notify chat of completion.
   */
  private async notifyCompletion(
    chatId: string,
    agentId: string,
    skillName: string,
    results: AgentMessage[]
  ): Promise<void> {
    const duration = this.getAgentDuration(agentId);
    const resultSummary = results.length > 0
      ? results[results.length - 1].content
      : 'No output';

    const message = `✅ **Skill Agent 完成**

技能: \`${skillName}\`
ID: \`${agentId}\`
耗时: ${duration}

**结果:**
${resultSummary}`;

    await this.callbacks.sendMessage(chatId, message);
  }

  /**
   * Notify chat of error.
   */
  private async notifyError(
    chatId: string,
    agentId: string,
    skillName: string,
    error: string
  ): Promise<void> {
    const message = `❌ **Skill Agent 失败**

技能: \`${skillName}\`
ID: \`${agentId}\`

**错误:**
${error}`;

    await this.callbacks.sendMessage(chatId, message);
  }

  /**
   * Notify chat of cancellation.
   */
  private async notifyCancellation(
    chatId: string,
    agentId: string,
    skillName: string
  ): Promise<void> {
    const message = `🚫 **Skill Agent 已取消**

技能: \`${skillName}\`
ID: \`${agentId}\``;

    await this.callbacks.sendMessage(chatId, message);
  }

  /**
   * Get agent duration string.
   */
  private getAgentDuration(agentId: string): string {
    const agent = this.runningAgents.get(agentId);
    if (!agent || !agent.completedAt) {
      return '未知';
    }

    const ms = agent.completedAt.getTime() - agent.startedAt.getTime();
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    } else {
      return `${(ms / 60000).toFixed(1)}min`;
    }
  }

  /**
   * Stop a running skill agent.
   *
   * @param agentId - Agent instance ID
   * @returns True if stopped, false if not found
   */
  stop(agentId: string): boolean {
    const agent = this.runningAgents.get(agentId);
    if (!agent) {
      return false;
    }

    if (agent.status !== 'running') {
      return false;
    }

    // Abort the execution
    agent.abortController.abort();

    logger.info({ agentId, skillName: agent.skillName }, 'Skill agent stop requested');

    return true;
  }

  /**
   * Get status of a specific agent.
   *
   * @param agentId - Agent instance ID
   * @returns Agent info or undefined if not found
   */
  getStatus(agentId: string): RunningSkillAgent | undefined {
    return this.runningAgents.get(agentId);
  }

  /**
   * List all running agents.
   *
   * @param chatId - Optional filter by chat ID
   * @returns Array of running agents
   */
  list(chatId?: string): RunningSkillAgent[] {
    const agents = Array.from(this.runningAgents.values());

    if (chatId) {
      return agents.filter(a => a.chatId === chatId);
    }

    return agents;
  }

  /**
   * Clear completed/failed agents from memory.
   *
   * @param maxAge - Maximum age in milliseconds (default: 1 hour)
   */
  cleanup(maxAge = 3600000): void {
    const now = Date.now();

    for (const [id, agent] of this.runningAgents) {
      if (agent.status !== 'running' && agent.completedAt) {
        const age = now - agent.completedAt.getTime();
        if (age > maxAge) {
          this.runningAgents.delete(id);
          logger.debug({ agentId: id }, 'Cleaned up old agent record');
        }
      }
    }
  }
}
