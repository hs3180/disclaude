/**
 * SkillAgentManager - Manages background execution of Skill Agents.
 *
 * This module provides the infrastructure for running Skill Agents
 * as background processes, as described in Issue #455:
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │                  Skill Agent System                         │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                             │
 * │   Feishu Command                                            │
 * │        │                                                    │
 * │        ▼                                                    │
 * │   ┌────────────────────────────────────────────┐           │
 * │   │         SkillAgentManager                  │           │
 * │   │                                            │           │
 * │   │  - discoverSkills()                        │           │
 * │   │  - start(skillName, options)               │           │
 * │   │  - stop(agentId)                           │           │
 * │   │  - list()                                  │           │
 * │   │  - getStatus(agentId)                      │           │
 * │   └────────────────────────────────────────────┘           │
 * │        │                                                    │
 * │        ▼                                                    │
 * │   ┌────────────────────────────────────────────┐           │
 * │   │         SkillAgent (Background)            │           │
 * │   │                                            │           │
 * │   │  - Execute skill file                      │           │
 * │   │  - Report progress                         │           │
 * │   │  - Notify on completion                    │           │
 * │   └────────────────────────────────────────────┘           │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Key Features:
 * - Background execution of skill agents
 * - Process lifecycle management
 * - Result notification to chat
 * - Skill discovery from skills directory
 *
 * @module agents/skill-agent-manager
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import { SkillAgent, type SkillAgentExecuteOptions } from './skill-agent.js';
import type { AgentMessage } from '../types/agent.js';
import type { BaseAgentConfig } from './types.js';

const logger = createLogger('SkillAgentManager');

/**
 * Information about an available skill.
 */
export interface SkillInfo {
  /** Skill name (from directory name) */
  name: string;
  /** Path to SKILL.md file */
  skillPath: string;
  /** Description from frontmatter */
  description?: string;
}

/**
 * Status of a running skill agent.
 */
export type AgentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Information about a running skill agent instance.
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
  startedAt: number;
  /** Completion timestamp (if completed) */
  completedAt?: number;
  /** Error message (if failed) */
  error?: string;
  /** Result summary (if completed) */
  result?: string;
  /** Abort controller for cancellation */
  abortController: AbortController;
}

/**
 * Options for starting a skill agent.
 */
export interface StartSkillOptions {
  /** Target chat ID for result notification */
  chatId: string;
  /** Template variables for skill execution */
  templateVars?: Record<string, string>;
  /** Additional input for the skill */
  input?: string;
  /** Callback for sending messages to chat */
  sendMessage?: (chatId: string, message: string) => Promise<void>;
}

/**
 * SkillAgentManager - Manages background execution of Skill Agents.
 *
 * Provides lifecycle management for skill agents running in the background,
 * including discovery, execution, monitoring, and result notification.
 *
 * @example
 * ```typescript
 * const manager = new SkillAgentManager(agentConfig);
 *
 * // Discover available skills
 * const skills = await manager.discoverSkills();
 *
 * // Start a skill agent
 * const agentId = await manager.start('site-miner', {
 *   chatId: 'oc_xxx',
 *   templateVars: { url: 'https://example.com' },
 *   sendMessage: async (chatId, msg) => { ... },
 * });
 *
 * // Check status
 * const status = manager.getStatus(agentId);
 *
 * // List all running agents
 * const running = manager.list();
 *
 * // Stop an agent
 * await manager.stop(agentId);
 * ```
 */
export class SkillAgentManager {
  /** Map of running agent instances */
  private runningAgents: Map<string, RunningAgentInfo> = new Map();

  /** Agent configuration for creating SkillAgent instances */
  private agentConfig: BaseAgentConfig;

  /** Cached skill discovery results */
  private skillCache: Map<string, SkillInfo> = new Map();

  /** Cache timestamp */
  private cacheTimestamp: number = 0;

  /** Cache TTL in milliseconds (5 minutes) */
  private readonly CACHE_TTL = 5 * 60 * 1000;

  /**
   * Create a SkillAgentManager.
   *
   * @param config - Agent configuration for creating SkillAgent instances
   */
  constructor(config: BaseAgentConfig) {
    this.agentConfig = config;
    logger.debug('SkillAgentManager created');
  }

  /**
   * Discover all available skills from the skills directory.
   *
   * Scans the skills directory for subdirectories containing SKILL.md files.
   * Results are cached for performance.
   *
   * @param forceRefresh - Force refresh the cache
   * @returns Array of available skill information
   */
  async discoverSkills(forceRefresh = false): Promise<SkillInfo[]> {
    const now = Date.now();

    // Return cached results if valid
    if (!forceRefresh && this.skillCache.size > 0 && (now - this.cacheTimestamp) < this.CACHE_TTL) {
      return Array.from(this.skillCache.values());
    }

    const skillsDir = path.join(Config.getWorkspaceDir(), 'skills');
    const skills: SkillInfo[] = [];

    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');

        try {
          await fs.access(skillPath);

          const skillInfo: SkillInfo = {
            name: entry.name,
            skillPath,
          };

          // Try to extract description from frontmatter
          try {
            const content = await fs.readFile(skillPath, 'utf-8');
            const descMatch = content.match(/^description:\s*(.+)$/m);
            if (descMatch) {
              skillInfo.description = descMatch[1].trim();
            }
          } catch {
            // Ignore parsing errors
          }

          skills.push(skillInfo);
          this.skillCache.set(skillInfo.name, skillInfo);
        } catch {
          // SKILL.md doesn't exist, skip
        }
      }

      this.cacheTimestamp = now;
      logger.info({ count: skills.length }, 'Discovered skills');
    } catch (error) {
      logger.warn({ error }, 'Failed to scan skills directory');
    }

    return skills;
  }

  /**
   * Get information about a specific skill.
   *
   * @param name - Skill name
   * @returns Skill info or undefined if not found
   */
  async getSkill(name: string): Promise<SkillInfo | undefined> {
    // Check cache first
    const cached = this.skillCache.get(name);
    if (cached) {
      return cached;
    }

    // Refresh and try again
    await this.discoverSkills(true);
    return this.skillCache.get(name);
  }

  /**
   * Start a skill agent in the background.
   *
   * Creates a new SkillAgent instance and executes it asynchronously.
   * The agent runs independently and notifies the chat when complete.
   *
   * @param skillName - Name of the skill to run
   * @param options - Start options including chatId for notifications
   * @returns Unique agent instance ID
   */
  async start(skillName: string, options: StartSkillOptions): Promise<string> {
    const skill = await this.getSkill(skillName);

    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    // Generate unique agent ID
    const agentId = `${skillName}-${crypto.randomUUID().slice(0, 8)}`;

    // Create abort controller for cancellation
    const abortController = new AbortController();

    // Create running agent info
    const agentInfo: RunningAgentInfo = {
      id: agentId,
      skillName,
      status: 'starting',
      chatId: options.chatId,
      startedAt: Date.now(),
      abortController,
    };

    this.runningAgents.set(agentId, agentInfo);

    logger.info({ agentId, skillName, chatId: options.chatId }, 'Starting skill agent');

    // Execute asynchronously in background
    this.executeInBackground(agentId, skill, options).catch(error => {
      logger.error({ agentId, error }, 'Background execution failed');
    });

    return agentId;
  }

  /**
   * Stop a running skill agent.
   *
   * @param agentId - Agent instance ID
   * @returns true if stopped, false if not found
   */
  async stop(agentId: string): Promise<boolean> {
    const agentInfo = this.runningAgents.get(agentId);

    if (!agentInfo) {
      return false;
    }

    if (agentInfo.status !== 'running' && agentInfo.status !== 'starting') {
      return false;
    }

    logger.info({ agentId }, 'Stopping skill agent');

    // Abort the execution
    agentInfo.abortController.abort();
    agentInfo.status = 'stopped';
    agentInfo.completedAt = Date.now();

    return true;
  }

  /**
   * Get the status of a running skill agent.
   *
   * @param agentId - Agent instance ID
   * @returns Agent info or undefined if not found
   */
  getStatus(agentId: string): RunningAgentInfo | undefined {
    return this.runningAgents.get(agentId);
  }

  /**
   * List all running skill agents.
   *
   * @param includeCompleted - Include completed/failed agents
   * @returns Array of running agent info
   */
  list(includeCompleted = false): RunningAgentInfo[] {
    const agents = Array.from(this.runningAgents.values());

    if (includeCompleted) {
      return agents;
    }

    return agents.filter(a => a.status === 'running' || a.status === 'starting');
  }

  /**
   * Clean up completed agents from memory.
   *
   * @param maxAge - Maximum age in milliseconds for completed agents
   */
  cleanup(maxAge: number = 60 * 60 * 1000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, info] of this.runningAgents) {
      if (info.completedAt && (now - info.completedAt) > maxAge) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.runningAgents.delete(id);
    }

    if (toDelete.length > 0) {
      logger.info({ count: toDelete.length }, 'Cleaned up completed agents');
    }
  }

  /**
   * Execute skill in background.
   *
   * This is the internal implementation that runs the skill agent
   * and handles completion notification.
   */
  private async executeInBackground(
    agentId: string,
    skill: SkillInfo,
    options: StartSkillOptions
  ): Promise<void> {
    const agentInfo = this.runningAgents.get(agentId);

    if (!agentInfo) {
      return;
    }

    try {
      // Update status
      agentInfo.status = 'running';

      // Create skill agent
      const skillAgent = new SkillAgent(this.agentConfig, skill.skillPath);

      // Build execute options
      const executeOptions: SkillAgentExecuteOptions = {
        templateVars: options.templateVars,
      };

      // Collect results
      const results: AgentMessage[] = [];

      // Execute with input if provided
      const iterator = options.input
        ? skillAgent.execute(options.input)
        : skillAgent.executeWithContext(executeOptions);

      for await (const message of iterator) {
        // Check for abort
        if (agentInfo.abortController.signal.aborted) {
          logger.info({ agentId }, 'Skill agent aborted');
          return;
        }

        results.push(message);
      }

      // Update status
      agentInfo.status = 'completed';
      agentInfo.completedAt = Date.now();

      // Extract result summary
      const lastMessage = results[results.length - 1];
      if (lastMessage) {
        agentInfo.result = lastMessage.content.slice(0, 500);
      }

      logger.info({ agentId, resultCount: results.length }, 'Skill agent completed');

      // Send completion notification
      if (options.sendMessage) {
        await this.sendCompletionNotification(agentInfo, options.sendMessage);
      }
    } catch (error) {
      const err = error as Error;

      // Check if aborted
      if (agentInfo.abortController.signal.aborted) {
        return;
      }

      logger.error({ agentId, error: err }, 'Skill agent failed');

      agentInfo.status = 'failed';
      agentInfo.completedAt = Date.now();
      agentInfo.error = err.message;

      // Send error notification
      if (options.sendMessage) {
        try {
          await options.sendMessage(
            options.chatId,
            `❌ **Skill Agent 失败**\n\n技能: ${skill.name}\n错误: ${err.message}`
          );
        } catch (notifyError) {
          logger.error({ agentId, error: notifyError }, 'Failed to send error notification');
        }
      }
    }
  }

  /**
   * Send completion notification to chat.
   */
  private async sendCompletionNotification(
    agentInfo: RunningAgentInfo,
    sendMessage: (chatId: string, message: string) => Promise<void>
  ): Promise<void> {
    const duration = Math.round((agentInfo.completedAt! - agentInfo.startedAt) / 1000);

    let message = `✅ **Skill Agent 完成**\n\n`;
    message += `技能: **${agentInfo.skillName}**\n`;
    message += `耗时: ${duration}秒\n`;
    message += `ID: \`${agentInfo.id}\`\n`;

    if (agentInfo.result) {
      message += `\n**结果摘要:**\n${agentInfo.result}`;
    }

    await sendMessage(agentInfo.chatId, message);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalManager: SkillAgentManager | undefined;

/**
 * Get the global SkillAgentManager instance.
 *
 * @param config - Optional config to initialize or reinitialize
 * @returns SkillAgentManager instance
 */
export function getSkillAgentManager(config?: BaseAgentConfig): SkillAgentManager {
  if (!globalManager && config) {
    globalManager = new SkillAgentManager(config);
  }

  if (!globalManager) {
    throw new Error('SkillAgentManager not initialized. Call getSkillAgentManager with config first.');
  }

  return globalManager;
}

/**
 * Reset the global manager (for testing).
 */
export function resetSkillAgentManager(): void {
  globalManager = undefined;
}
