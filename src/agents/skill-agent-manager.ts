/**
 * SkillAgentManager - Manages background skill agent processes.
 *
 * This module implements the Skill Agent System as described in Issue #455:
 * - Start/stop skill agents that run in the background
 * - Track running agents and their status
 * - Support result notification via chatId
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
  /** Path to skill file */
  skillPath: string;
  /** Current status */
  status: SkillAgentStatus;
  /** When the agent was started */
  startedAt: string;
  /** When the agent completed (if applicable) */
  completedAt?: string;
  /** Chat ID for result notification */
  chatId?: string;
  /** Result summary (if completed) */
  result?: string;
  /** Error message (if failed) */
  error?: string;
  /** Template variables passed to the skill */
  templateVars?: Record<string, string>;
}

/**
 * Options for starting a skill agent.
 */
export interface StartSkillAgentOptions {
  /** Path to skill file (relative to workspace or absolute) */
  skillPath: string;
  /** Chat ID for result notification */
  chatId?: string;
  /** Template variables to substitute in skill content */
  templateVars?: Record<string, string>;
  /** Callback when agent completes */
  onComplete?: (result: string) => void;
  /** Callback when agent fails */
  onError?: (error: string) => void;
}

/**
 * Manager for background skill agent processes.
 *
 * Provides CLI command support for Issue #455:
 * - `disclaude skill run <skill-name>` - Start a skill agent
 * - `disclaude skill list` - List running agents
 * - `disclaude skill stop <agent-id>` - Stop an agent
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
 * // List running agents
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

  /** Map of agent ID to abort controller */
  private abortControllers: Map<string, AbortController> = new Map();

  /** Agent configuration */
  private agentConfig: BaseAgentConfig;

  /** Path to state file for persistence */
  private stateFilePath: string;

  /**
   * Create a SkillAgentManager.
   *
   * @param agentConfig - Configuration for creating skill agents
   */
  constructor(agentConfig: BaseAgentConfig) {
    this.agentConfig = agentConfig;
    this.stateFilePath = path.join(Config.getWorkspaceDir(), '.skill-agents.json');
    this.loadState().catch(err => {
      logger.warn({ err }, 'Failed to load skill agent state');
    });
  }

  /**
   * Start a skill agent in the background.
   *
   * @param options - Start options
   * @returns Agent ID
   */
  async start(options: StartSkillAgentOptions): Promise<string> {
    const agentId = uuidv4();
    const skillName = path.basename(options.skillPath, '.md').replace('/SKILL', '');

    // Create agent info
    const info: SkillAgentInfo = {
      id: agentId,
      name: skillName,
      skillPath: options.skillPath,
      status: 'running',
      startedAt: new Date().toISOString(),
      chatId: options.chatId,
      templateVars: options.templateVars,
    };

    this.agents.set(agentId, info);
    await this.saveState();

    logger.info({ agentId, skillPath: options.skillPath }, 'Starting skill agent');

    // Create abort controller for cancellation
    const abortController = new AbortController();
    this.abortControllers.set(agentId, abortController);

    // Create and run skill agent asynchronously
    this.runAgentAsync(agentId, options, abortController.signal)
      .then(result => {
        options.onComplete?.(result);
      })
      .catch(error => {
        if (error.name !== 'AbortError') {
          options.onError?.(error.message);
        }
      });

    return agentId;
  }

  /**
   * Run a skill agent asynchronously.
   */
  private async runAgentAsync(
    agentId: string,
    options: StartSkillAgentOptions,
    abortSignal: AbortSignal
  ): Promise<string> {
    const info = this.agents.get(agentId);
    if (!info) {
      throw new Error(`Agent ${agentId} not found`);
    }

    try {
      // Create skill agent
      const agent = new SkillAgent(this.agentConfig, options.skillPath);
      this.runningAgents.set(agentId, agent);

      // Execute skill
      const executeOptions: SkillAgentExecuteOptions = {
        templateVars: options.templateVars,
      };

      let result = '';
      for await (const message of agent.executeWithContext(executeOptions)) {
        if (abortSignal.aborted) {
          throw new DOMException('Agent stopped', 'AbortError');
        }
        result += message.content + '\n';
      }

      // Update status
      info.status = 'completed';
      info.completedAt = new Date().toISOString();
      info.result = result.slice(0, 1000); // Truncate result for storage
      await this.saveState();

      logger.info({ agentId, resultLength: result.length }, 'Skill agent completed');

      // Clean up
      this.runningAgents.delete(agentId);
      this.abortControllers.delete(agentId);
      agent.dispose();

      return result;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info({ agentId }, 'Skill agent stopped');
        throw error;
      }

      // Update status
      info.status = 'failed';
      info.completedAt = new Date().toISOString();
      info.error = error instanceof Error ? error.message : String(error);
      await this.saveState();

      logger.error({ err: error, agentId }, 'Skill agent failed');

      // Clean up
      this.runningAgents.delete(agentId);
      this.abortControllers.delete(agentId);

      throw error;
    }
  }

  /**
   * Stop a running skill agent.
   *
   * @param agentId - Agent ID to stop
   */
  async stop(agentId: string): Promise<void> {
    const info = this.agents.get(agentId);
    if (!info) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (info.status !== 'running') {
      throw new Error(`Agent ${agentId} is not running (status: ${info.status})`);
    }

    logger.info({ agentId }, 'Stopping skill agent');

    // Abort the agent
    const abortController = this.abortControllers.get(agentId);
    if (abortController) {
      abortController.abort();
    }

    // Dispose the agent
    const agent = this.runningAgents.get(agentId);
    if (agent) {
      agent.dispose();
    }

    // Update status
    info.status = 'stopped';
    info.completedAt = new Date().toISOString();
    await this.saveState();

    // Clean up
    this.runningAgents.delete(agentId);
    this.abortControllers.delete(agentId);
  }

  /**
   * List all skill agents.
   *
   * @param filter - Optional status filter
   * @returns Array of agent info
   */
  list(filter?: SkillAgentStatus): SkillAgentInfo[] {
    const agents = Array.from(this.agents.values());
    if (filter) {
      return agents.filter(a => a.status === filter);
    }
    return agents;
  }

  /**
   * Get info about a specific agent.
   *
   * @param agentId - Agent ID
   * @returns Agent info or undefined
   */
  get(agentId: string): SkillAgentInfo | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Clear completed/failed agents from history.
   */
  async clearHistory(): Promise<void> {
    const runningAgents = Array.from(this.agents.values()).filter(
      a => a.status === 'running'
    );
    this.agents.clear();
    runningAgents.forEach(a => this.agents.set(a.id, a));
    await this.saveState();
  }

  /**
   * Save state to file.
   */
  private async saveState(): Promise<void> {
    try {
      const state = Array.from(this.agents.values());
      await fs.writeFile(
        this.stateFilePath,
        JSON.stringify(state, null, 2),
        'utf-8'
      );
    } catch (error) {
      logger.warn({ err: error }, 'Failed to save skill agent state');
    }
  }

  /**
   * Load state from file.
   */
  private async loadState(): Promise<void> {
    try {
      const content = await fs.readFile(this.stateFilePath, 'utf-8');
      const state: SkillAgentInfo[] = JSON.parse(content);
      state.forEach(info => {
        // Only restore non-running agents (running agents need to be restarted)
        if (info.status !== 'running') {
          this.agents.set(info.id, info);
        }
      });
      logger.info({ count: this.agents.size }, 'Loaded skill agent state');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err: error }, 'Failed to load skill agent state');
      }
    }
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    // Stop all running agents
    for (const [agentId] of this.runningAgents) {
      const abortController = this.abortControllers.get(agentId);
      if (abortController) {
        abortController.abort();
      }
      const agent = this.runningAgents.get(agentId);
      if (agent) {
        agent.dispose();
      }
    }
    this.runningAgents.clear();
    this.abortControllers.clear();
  }
}

// Singleton instance for CLI use
let defaultManager: SkillAgentManager | null = null;

/**
 * Get the default SkillAgentManager instance.
 *
 * @param agentConfig - Optional agent config (required on first call)
 */
export function getSkillAgentManager(agentConfig?: BaseAgentConfig): SkillAgentManager {
  if (!defaultManager && agentConfig) {
    defaultManager = new SkillAgentManager(agentConfig);
  }
  if (!defaultManager) {
    throw new Error('SkillAgentManager not initialized. Call with agentConfig first.');
  }
  return defaultManager;
}
