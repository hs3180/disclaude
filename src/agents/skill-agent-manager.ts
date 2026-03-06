/**
 * SkillAgentManager - Manages lifecycle of background Skill Agents.
 *
 * This module implements the Skill Agent system as described in Issue #455:
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    Skill Agent Architecture                  │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                             │
 * │   Chat Agent (Pilot)                                        │
 * │        │                                                    │
 * │        │ /skill run <name> [options]                        │
 * │        ▼                                                    │
 * │   ┌────────────────────────────────────────────┐            │
 * │   │            SkillAgentManager                │            │
 * │   │                                            │            │
 * │   │  ┌─────────┐ ┌─────────┐ ┌─────────┐      │            │
 * │   │  │ Agent 1 │ │ Agent 2 │ │ Agent N │      │            │
 * │   │  │ (skill) │ │ (skill) │ │ (skill) │      │            │
 * │   │  └─────────┘ └─────────┘ └─────────┘      │            │
 * │   └────────────────────────────────────────────┘            │
 * │        │                                                    │
 * │        │ sendMessage (on completion)                        │
 * │        ▼                                                    │
 * │   User (via Feishu)                                         │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Key Features:
 * - Start/stop Skill Agents on demand
 * - Track running agents and their status
 * - Send completion notifications to users
 * - Maximum concurrent agent limit
 *
 * @module agents/skill-agent-manager
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import { SkillAgent, type SkillAgentExecuteOptions } from './skill-agent.js';
import { findSkill, listSkills, type DiscoveredSkill } from '../skills/finder.js';
import type { BaseAgentConfig } from './types.js';

const logger = createLogger('SkillAgentManager');

/**
 * Status of a running Skill Agent.
 */
export type AgentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Information about a running Skill Agent.
 */
export interface RunningAgentInfo {
  /** Unique agent instance ID */
  id: string;
  /** Skill name */
  skillName: string;
  /** Current status */
  status: AgentStatus;
  /** Target chat ID for notifications */
  chatId: string;
  /** Start timestamp */
  startedAt: Date;
  /** Completion timestamp (if completed/failed/stopped) */
  completedAt?: Date;
  /** Error message (if failed) */
  error?: string;
  /** Result summary (if completed) */
  result?: string;
  /** AbortController for cancellation */
  abortController: AbortController;
}

/**
 * Configuration for SkillAgentManager.
 */
export interface SkillAgentManagerConfig {
  /** Maximum concurrent agents (default: 5) */
  maxConcurrent?: number;
  /** Base agent config for creating SkillAgents */
  baseAgentConfig: BaseAgentConfig;
  /** Callback to send messages to users */
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

/**
 * Options for starting a Skill Agent.
 */
export interface StartAgentOptions {
  /** Skill name to run */
  skillName: string;
  /** Target chat ID for notifications */
  chatId: string;
  /** Template variables for skill execution */
  templateVars?: Record<string, string>;
  /** Additional input for the skill */
  input?: string;
}

/**
 * Cache entry for skill discovery.
 */
interface SkillCacheEntry {
  skills: DiscoveredSkill[];
  cachedAt: number;
}

/**
 * SkillAgentManager - Manages lifecycle of background Skill Agents.
 *
 * Provides:
 * - Skill discovery and caching
 * - Agent lifecycle management (start/stop/status)
 * - Concurrent execution limits
 * - Completion notifications
 *
 * @example
 * ```typescript
 * const manager = new SkillAgentManager({
 *   baseAgentConfig: { apiKey: '...', model: 'claude-3-5-sonnet-20241022' },
 *   sendMessage: async (chatId, text) => { ... },
 * });
 *
 * // Start a skill agent
 * const agentId = await manager.startAgent({
 *   skillName: 'site-miner',
 *   chatId: 'oc_xxx',
 *   input: 'Extract product info from https://example.com',
 * });
 *
 * // Check status
 * const info = manager.getAgentInfo(agentId);
 * console.log(info?.status);
 *
 * // Stop if needed
 * await manager.stopAgent(agentId);
 * ```
 */
export class SkillAgentManager {
  /** Running agents indexed by ID */
  private runningAgents = new Map<string, RunningAgentInfo>();

  /** Skill discovery cache with TTL */
  private skillCache: SkillCacheEntry | null = null;

  /** Cache TTL in milliseconds (5 minutes) */
  private readonly cacheTtl = 5 * 60 * 1000;

  /** Maximum concurrent agents */
  private readonly maxConcurrent: number;

  /** Base agent config for creating SkillAgents */
  private readonly baseAgentConfig: BaseAgentConfig;

  /** Callback to send messages to users */
  private readonly sendMessage: (chatId: string, text: string) => Promise<void>;

  constructor(config: SkillAgentManagerConfig) {
    this.maxConcurrent = config.maxConcurrent ?? 5;
    this.baseAgentConfig = config.baseAgentConfig;
    this.sendMessage = config.sendMessage;

    logger.info(
      { maxConcurrent: this.maxConcurrent },
      'SkillAgentManager initialized'
    );
  }

  /**
   * Discover all available skills.
   *
   * Uses caching to avoid frequent disk scans.
   *
   * @param forceRefresh - Force refresh the cache
   * @returns Array of discovered skills
   */
  async discoverSkills(forceRefresh = false): Promise<DiscoveredSkill[]> {
    // Check cache
    if (!forceRefresh && this.skillCache) {
      const age = Date.now() - this.skillCache.cachedAt;
      if (age < this.cacheTtl) {
        logger.debug({ count: this.skillCache.skills.length }, 'Using cached skills');
        return this.skillCache.skills;
      }
    }

    // Refresh cache
    const skills = await listSkills();
    this.skillCache = {
      skills,
      cachedAt: Date.now(),
    };

    logger.debug({ count: skills.length }, 'Skills discovered');
    return skills;
  }

  /**
   * Get a skill by name.
   *
   * @param name - Skill name
   * @returns Skill path or null if not found
   */
  async getSkill(name: string): Promise<string | null> {
    return findSkill(name);
  }

  /**
   * Start a Skill Agent.
   *
   * Creates a new SkillAgent instance and runs it in the background.
   * Sends a completion notification when done.
   *
   * @param options - Start options
   * @returns Agent instance ID
   * @throws Error if max concurrent limit reached or skill not found
   */
  async startAgent(options: StartAgentOptions): Promise<string> {
    // Check concurrent limit
    if (this.runningAgents.size >= this.maxConcurrent) {
      throw new Error(
        `Maximum concurrent agents reached (${this.maxConcurrent}). ` +
        `Please wait for existing agents to complete.`
      );
    }

    // Find skill
    const skillPath = await this.getSkill(options.skillName);
    if (!skillPath) {
      throw new Error(`Skill not found: ${options.skillName}`);
    }

    // Create agent ID and abort controller
    const agentId = uuidv4();
    const abortController = new AbortController();

    // Create agent info
    const info: RunningAgentInfo = {
      id: agentId,
      skillName: options.skillName,
      status: 'starting',
      chatId: options.chatId,
      startedAt: new Date(),
      abortController,
    };

    // Register agent
    this.runningAgents.set(agentId, info);

    logger.info(
      { agentId, skillName: options.skillName, chatId: options.chatId },
      'Starting Skill Agent'
    );

    // Run agent in background
    this.runAgentInBackground(agentId, skillPath, options).catch((error) => {
      logger.error({ agentId, error }, 'Failed to start agent');
      this.handleAgentError(agentId, error);
    });

    return agentId;
  }

  /**
   * Run a Skill Agent in the background.
   */
  private async runAgentInBackground(
    agentId: string,
    skillPath: string,
    options: StartAgentOptions
  ): Promise<void> {
    const info = this.runningAgents.get(agentId);
    if (!info) {
      return;
    }

    // Update status
    info.status = 'running';

    // Create SkillAgent
    const agent = new SkillAgent(this.baseAgentConfig, skillPath);

    try {
      // Build execute options
      const executeOptions: SkillAgentExecuteOptions = {
        templateVars: options.templateVars,
      };

      // Collect results
      const results: string[] = [];

      // Execute with optional input
      const generator = options.input
        ? agent.execute(options.input)
        : agent.executeWithContext(executeOptions);

      for await (const message of generator) {
        // Check for cancellation
        if (info.abortController.signal.aborted) {
          info.status = 'stopped';
          info.completedAt = new Date();
          logger.info({ agentId }, 'Agent stopped by user');
          return;
        }

        // Collect message content
        if (message.content) {
          if (typeof message.content === 'string') {
            results.push(message.content);
          } else if (Array.isArray(message.content)) {
            // Extract text from ContentBlock[]
            const textContent = message.content
              .filter((block): block is { type: 'text'; text: string } =>
                block.type === 'text' && typeof block.text === 'string'
              )
              .map((block) => block.text)
              .join('\n');
            if (textContent) {
              results.push(textContent);
            }
          }
        }
      }

      // Mark as completed
      info.status = 'completed';
      info.completedAt = new Date();
      info.result = results.join('\n').slice(0, 1000); // Limit result size

      logger.info({ agentId, skillName: options.skillName }, 'Agent completed');

      // Send completion notification
      await this.sendCompletionNotification(info);

    } catch (error) {
      this.handleAgentError(agentId, error);
    } finally {
      agent.dispose();
    }
  }

  /**
   * Handle agent execution error.
   */
  private async handleAgentError(agentId: string, error: unknown): Promise<void> {
    const info = this.runningAgents.get(agentId);
    if (!info) {
      return;
    }

    info.status = 'failed';
    info.completedAt = new Date();
    info.error = error instanceof Error ? error.message : String(error);

    logger.error({ agentId, error: info.error }, 'Agent failed');

    // Send error notification
    try {
      await this.sendMessage(
        info.chatId,
        `❌ **Skill Agent 失败**\n\n` +
        `技能: ${info.skillName}\n` +
        `错误: ${info.error}`
      );
    } catch (sendError) {
      logger.error({ agentId, sendError }, 'Failed to send error notification');
    }
  }

  /**
   * Send completion notification to user.
   */
  private async sendCompletionNotification(info: RunningAgentInfo): Promise<void> {
    const duration = info.completedAt!
      ? Math.round((info.completedAt!.getTime() - info.startedAt.getTime()) / 1000)
      : 0;

    const message =
      `✅ **Skill Agent 完成**\n\n` +
      `技能: ${info.skillName}\n` +
      `耗时: ${duration}秒\n` +
      `状态: ${info.status}`;

    try {
      await this.sendMessage(info.chatId, message);
    } catch (error) {
      logger.error({ agentId: info.id, error }, 'Failed to send completion notification');
    }
  }

  /**
   * Stop a running Skill Agent.
   *
   * @param agentId - Agent instance ID
   * @returns True if agent was stopped, false if not found or already stopped
   */
  async stopAgent(agentId: string): Promise<boolean> {
    const info = this.runningAgents.get(agentId);
    if (!info) {
      return false;
    }

    if (info.status !== 'running' && info.status !== 'starting') {
      return false;
    }

    // Abort the agent
    info.abortController.abort();

    logger.info({ agentId }, 'Agent stop requested');
    return true;
  }

  /**
   * Get information about a running agent.
   *
   * @param agentId - Agent instance ID
   * @returns Agent info or undefined if not found
   */
  getAgentInfo(agentId: string): RunningAgentInfo | undefined {
    return this.runningAgents.get(agentId);
  }

  /**
   * List all running agents.
   *
   * @returns Array of running agent info
   */
  listRunningAgents(): RunningAgentInfo[] {
    return Array.from(this.runningAgents.values());
  }

  /**
   * Clean up completed/failed agents older than the specified age.
   *
   * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
   * @returns Number of agents cleaned up
   */
  cleanupOldAgents(maxAgeMs = 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, info] of this.runningAgents.entries()) {
      if (
        (info.status === 'completed' || info.status === 'failed' || info.status === 'stopped') &&
        info.completedAt &&
        now - info.completedAt.getTime() > maxAgeMs
      ) {
        this.runningAgents.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned }, 'Cleaned up old agents');
    }

    return cleaned;
  }

  /**
   * Get current statistics.
   */
  getStats(): {
    total: number;
    running: number;
    completed: number;
    failed: number;
    maxConcurrent: number;
  } {
    const agents = Array.from(this.runningAgents.values());
    return {
      total: agents.length,
      running: agents.filter((a) => a.status === 'running').length,
      completed: agents.filter((a) => a.status === 'completed').length,
      failed: agents.filter((a) => a.status === 'failed').length,
      maxConcurrent: this.maxConcurrent,
    };
  }
}

// Singleton instance
let instance: SkillAgentManager | null = null;

/**
 * Get the singleton SkillAgentManager instance.
 *
 * @param config - Configuration (only used on first call)
 * @returns SkillAgentManager instance
 */
export function getSkillAgentManager(config?: SkillAgentManagerConfig): SkillAgentManager {
  if (!instance) {
    if (!config) {
      throw new Error('SkillAgentManager not initialized. Call with config first.');
    }
    instance = new SkillAgentManager(config);
  }
  return instance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetSkillAgentManager(): void {
  instance = null;
}
