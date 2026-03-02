/**
 * SkillAgentManager - Manages background skill agent processes.
 *
 * This module implements the Skill Agent System as described in Issue #455:
 * - Start/stop skill agents that run in the background
 * - Track running agents and their status
 * - Support result notification via chatId
 *
 * Usage is through Feishu control commands:
 * - /skill run <skill-name> [vars...] - Start a skill agent
 * - /skill list - List running agents
 * - /skill stop <agent-id> - Stop an agent
 *
 * @module agents/skill-agent-manager
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { SkillAgent, type SkillAgentExecuteOptions } from './skill-agent.js';
import type { BaseAgentConfig } from './types.js';

const logger = createLogger('SkillAgentManager');

/**
 * Status of a skill agent.
 */
export type SkillAgentStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Information about a running skill agent.
 */
export interface SkillAgentInfo {
  /** Unique agent ID */
  id: string;
  /** Skill name (derived from skill file) */
  name: string;
  /** Skill path */
  skillPath: string;
  /** Current status */
  status: SkillAgentStatus;
  /** Chat ID for result notification */
  chatId?: string;
  /** Template variables used */
  templateVars?: Record<string, string>;
  /** ISO timestamp when agent started */
  startedAt: string;
  /** ISO timestamp when agent completed/failed/stopped */
  completedAt?: string;
  /** Result content (for completed agents) */
  result?: string;
  /** Error message (for failed agents) */
  error?: string;
}

/**
 * Options for starting a skill agent.
 */
export interface StartSkillAgentOptions {
  /** Path to skill markdown file (relative to workspace or absolute) */
  skillPath: string;
  /** Chat ID for result notification */
  chatId?: string;
  /** Template variables to substitute in skill content */
  templateVars?: Record<string, string>;
  /** Callback when agent completes successfully */
  onComplete?: (result: string) => void;
  /** Callback when agent fails */
  onError?: (error: string) => void;
}

/**
 * Global singleton instance for cross-module access.
 */
let globalManager: SkillAgentManager | null = null;

/**
 * Get the global SkillAgentManager instance.
 * Returns null if not initialized.
 */
export function getSkillAgentManager(): SkillAgentManager | null {
  return globalManager;
}

/**
 * SkillAgentManager - Manages background skill agent processes.
 *
 * @example
 * ```typescript
 * const manager = new SkillAgentManager(agentConfig);
 *
 * // Start a skill agent
 * const agentId = await manager.start({
 *   skillPath: 'skills/evaluator/SKILL.md',
 *   chatId: 'oc_xxx',
 *   templateVars: { taskId: 'task-123' },
 * });
 *
 * // List all agents
 * const agents = manager.list();
 *
 * // Stop an agent
 * await manager.stop(agentId);
 * ```
 */
export class SkillAgentManager {
  /** Map of agent ID to agent info */
  private agents: Map<string, SkillAgentInfo> = new Map();

  /** Map of agent ID to running SkillAgent instance */
  private runningAgents: Map<string, SkillAgent> = new Map();

  /** Agent configuration for creating SkillAgent instances */
  private agentConfig: BaseAgentConfig;

  /** Path to state persistence file */
  private statePath: string;

  /** Whether the manager has been disposed */
  private disposed = false;

  /**
   * Create a SkillAgentManager.
   *
   * @param agentConfig - Agent configuration for creating SkillAgent instances
   */
  constructor(agentConfig: BaseAgentConfig) {
    this.agentConfig = agentConfig;
    this.statePath = path.join(Config.getWorkspaceDir(), '.skill-agents.json');

    // Set as global instance
    globalManager = this;

    logger.debug('SkillAgentManager created');
  }

  /**
   * Start a skill agent in the background.
   *
   * @param options - Start options
   * @returns Agent ID
   */
  async start(options: StartSkillAgentOptions): Promise<string> {
    if (this.disposed) {
      throw new Error('SkillAgentManager has been disposed');
    }

    const { skillPath, chatId, templateVars, onComplete, onError } = options;

    // Resolve skill path
    const resolvedPath = path.isAbsolute(skillPath)
      ? skillPath
      : path.join(Config.getWorkspaceDir(), skillPath);

    // Verify skill file exists
    try {
      await fs.access(resolvedPath);
    } catch {
      throw new Error(`Skill file not found: ${resolvedPath}`);
    }

    // Generate agent ID
    const id = uuidv4();
    const name = path.basename(skillPath, '.md');
    const startedAt = new Date().toISOString();

    // Create agent info
    const info: SkillAgentInfo = {
      id,
      name,
      skillPath: resolvedPath,
      status: 'running',
      chatId,
      templateVars,
      startedAt,
    };

    this.agents.set(id, info);
    await this.persistState();

    logger.info({ agentId: id, skillPath: resolvedPath }, 'Starting skill agent');

    // Create and run SkillAgent in background
    const agent = new SkillAgent(this.agentConfig, resolvedPath);
    this.runningAgents.set(id, agent);

    // Run agent asynchronously (non-blocking)
    this.runAgent(id, agent, templateVars, onComplete, onError).catch(error => {
      logger.error({ agentId: id, error }, 'Agent run failed');
    });

    return id;
  }

  /**
   * Run a skill agent and update status on completion.
   */
  private async runAgent(
    id: string,
    agent: SkillAgent,
    templateVars?: Record<string, string>,
    onComplete?: (result: string) => void,
    onError?: (error: string) => void
  ): Promise<void> {
    const info = this.agents.get(id);
    if (!info) {
      return;
    }

    try {
      agent.initialize();

      const options: SkillAgentExecuteOptions = templateVars
        ? { templateVars }
        : {};

      let result = '';
      for await (const message of agent.executeWithContext(options)) {
        if (message.content) {
          result += message.content;
        }
      }

      // Update status to completed
      info.status = 'completed';
      info.completedAt = new Date().toISOString();
      info.result = result;
      await this.persistState();

      logger.info({ agentId: id, resultLength: result.length }, 'Skill agent completed');

      // Call completion callback
      if (onComplete) {
        onComplete(result);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Update status to failed
      info.status = 'failed';
      info.completedAt = new Date().toISOString();
      info.error = errorMessage;
      await this.persistState();

      logger.error({ agentId: id, error: errorMessage }, 'Skill agent failed');

      // Call error callback
      if (onError) {
        onError(errorMessage);
      }
    } finally {
      this.runningAgents.delete(id);
    }
  }

  /**
   * List all skill agents, optionally filtered by status.
   *
   * @param status - Optional status filter
   * @returns Array of agent info
   */
  list(status?: SkillAgentStatus): SkillAgentInfo[] {
    const all = Array.from(this.agents.values());
    if (status) {
      return all.filter(info => info.status === status);
    }
    return all;
  }

  /**
   * Get information about a specific agent.
   *
   * @param id - Agent ID
   * @returns Agent info or undefined if not found
   */
  get(id: string): SkillAgentInfo | undefined {
    return this.agents.get(id);
  }

  /**
   * Stop a running agent.
   *
   * @param id - Agent ID
   */
  async stop(id: string): Promise<void> {
    const info = this.agents.get(id);
    if (!info) {
      throw new Error(`Agent not found: ${id}`);
    }

    if (info.status !== 'running') {
      throw new Error(`Agent is not running: ${id} (status: ${info.status})`);
    }

    // Dispose the running agent
    const agent = this.runningAgents.get(id);
    if (agent) {
      try {
        agent.dispose();
      } catch (error) {
        logger.warn({ agentId: id, error }, 'Error disposing agent');
      }
      this.runningAgents.delete(id);
    }

    // Update status
    info.status = 'stopped';
    info.completedAt = new Date().toISOString();
    await this.persistState();

    logger.info({ agentId: id }, 'Skill agent stopped');
  }

  /**
   * Clear completed, failed, and stopped agents from history.
   * Running agents are not affected.
   */
  async clearHistory(): Promise<void> {
    for (const [id, info] of this.agents) {
      if (info.status !== 'running') {
        this.agents.delete(id);
      }
    }
    await this.persistState();
    logger.debug('Cleared agent history');
  }

  /**
   * Persist agent state to file.
   */
  private async persistState(): Promise<void> {
    try {
      const state = {
        agents: Array.from(this.agents.values()),
        savedAt: new Date().toISOString(),
      };
      await fs.writeFile(this.statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      logger.warn({ error }, 'Failed to persist agent state');
    }
  }

  /**
   * Load agent state from file.
   * Note: This only loads historical data; running agents cannot be resumed.
   */
  async loadState(): Promise<void> {
    try {
      const content = await fs.readFile(this.statePath, 'utf-8');
      const state = JSON.parse(content);

      // Only load non-running agents (running agents cannot be resumed)
      for (const info of state.agents || []) {
        if (info.status !== 'running') {
          this.agents.set(info.id, info);
        }
      }

      logger.debug({ count: this.agents.size }, 'Loaded agent state');
    } catch (error) {
      // File doesn't exist or is invalid - that's OK
      logger.debug('No existing agent state found');
    }
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    this.disposed = true;

    // Stop all running agents
    for (const [id, agent] of this.runningAgents) {
      try {
        agent.dispose();
      } catch (error) {
        logger.warn({ agentId: id, error }, 'Error disposing agent during cleanup');
      }
    }
    this.runningAgents.clear();

    // Clear global instance if it's us
    if (globalManager === this) {
      globalManager = null;
    }

    logger.debug('SkillAgentManager disposed');
  }
}
