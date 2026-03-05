/**
 * SkillAgentManager - Manages background skill agent processes.
 *
 * This manager handles the lifecycle of skill agents that run independently
 * from the main chat agent, allowing for background task execution.
 *
 * Issue #455: Skill Agent System - 后台执行的独立 Agent 进程
 *
 * Key Features:
 * - Start/stop skill agents that run independently
 * - Track running agents and their status
 * - Support result notification via chatId
 * - State persistence to workspace
 *
 * @module agents/skill-agent-manager
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import { SkillAgent, type SkillAgentExecuteOptions } from './skill-agent.js';
import { AgentFactory } from './factory.js';

const logger = createLogger('SkillAgentManager');

/**
 * Status of a skill agent.
 */
export type SkillAgentStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Information about a running or completed skill agent.
 */
export interface SkillAgentInfo {
  /** Unique agent ID */
  id: string;
  /** Skill name (derived from skill file) */
  skillName: string;
  /** Path to skill file */
  skillPath: string;
  /** Chat ID for result notification */
  chatId: string;
  /** Current status */
  status: SkillAgentStatus;
  /** When the agent was started */
  startedAt: string;
  /** When the agent completed/failed/stopped (if applicable) */
  endedAt?: string;
  /** Error message if failed */
  error?: string;
  /** Result summary (if completed) */
  result?: string;
  /** Template variables used */
  templateVars?: Record<string, string>;
}

/**
 * Options for starting a skill agent.
 */
export interface StartSkillAgentOptions {
  /** Path to skill file (relative to workspace or absolute) */
  skillPath: string;
  /** Chat ID for result notification */
  chatId: string;
  /** Template variables to substitute */
  templateVars?: Record<string, string>;
  /** Callback when agent completes */
  onComplete?: (result: string) => void;
  /** Callback when agent fails */
  onError?: (error: string) => void;
}

/**
 * State file structure for persistence.
 */
interface SkillAgentManagerState {
  /** Version for migration support */
  version: 1;
  /** List of agents (both running and historical) */
  agents: SkillAgentInfo[];
}

/**
 * Manages background skill agent processes.
 *
 * @example
 * ```typescript
 * const manager = new SkillAgentManager();
 *
 * // Start a skill agent
 * const agentId = await manager.start({
 *   skillPath: 'skills/site-miner/SKILL.md',
 *   chatId: 'oc_xxx',
 *   templateVars: { url: 'https://example.com' },
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
  /** Path to state file */
  private statePath: string;

  /** In-memory agent registry */
  private agents: Map<string, SkillAgentInfo> = new Map();

  /** Running agent instances */
  private runningAgents: Map<string, SkillAgent> = new Map();

  /** Abort controllers for running agents */
  private abortControllers: Map<string, AbortController> = new Map();

  constructor() {
    this.statePath = path.join(Config.getWorkspaceDir(), '.skill-agents.json');
  }

  /**
   * Initialize the manager by loading state from disk.
   */
  async initialize(): Promise<void> {
    await this.loadState();
    logger.info({ agentCount: this.agents.size }, 'SkillAgentManager initialized');
  }

  /**
   * Load state from disk.
   */
  private async loadState(): Promise<void> {
    try {
      const content = await fs.readFile(this.statePath, 'utf-8');
      const state: SkillAgentManagerState = JSON.parse(content);

      // Load agents into memory
      for (const agent of state.agents) {
        this.agents.set(agent.id, agent);

        // Note: Running agents from previous session are marked as stopped
        if (agent.status === 'running') {
          agent.status = 'stopped';
          agent.endedAt = new Date().toISOString();
          agent.error = 'Process restarted';
        }
      }

      logger.debug({ count: this.agents.size }, 'Loaded agent state from disk');
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ error }, 'Failed to load agent state, starting fresh');
      }
    }
  }

  /**
   * Save state to disk.
   */
  private async saveState(): Promise<void> {
    const state: SkillAgentManagerState = {
      version: 1,
      agents: Array.from(this.agents.values()),
    };

    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2));

    logger.debug({ count: state.agents.length }, 'Saved agent state to disk');
  }

  /**
   * Generate a unique agent ID.
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `skill-${timestamp}-${random}`;
  }

  /**
   * Start a new skill agent.
   *
   * @param options - Start options
   * @returns Agent ID
   */
  async start(options: StartSkillAgentOptions): Promise<string> {
    const agentId = this.generateId();
    // Extract skill name from path: skills/test/SKILL.md -> test
    const pathParts = options.skillPath.split('/');
    const skillName = pathParts.length >= 2
      ? pathParts[pathParts.length - 2] // Get parent directory name
      : path.basename(options.skillPath, '.md');

    // Create agent info
    const info: SkillAgentInfo = {
      id: agentId,
      skillName,
      skillPath: options.skillPath,
      chatId: options.chatId,
      status: 'running',
      startedAt: new Date().toISOString(),
      templateVars: options.templateVars,
    };

    // Register agent
    this.agents.set(agentId, info);
    await this.saveState();

    // Create abort controller
    const abortController = new AbortController();
    this.abortControllers.set(agentId, abortController);

    // Create and run skill agent in background
    this.runAgentInBackground(agentId, options, abortController.signal)
      .then(result => {
        info.status = 'completed';
        info.endedAt = new Date().toISOString();
        info.result = result;
        options.onComplete?.(result);
      })
      .catch(error => {
        if (error.name === 'AbortError') {
          info.status = 'stopped';
          info.endedAt = new Date().toISOString();
        } else {
          info.status = 'failed';
          info.endedAt = new Date().toISOString();
          info.error = error.message;
          options.onError?.(error.message);
        }
      })
      .finally(() => {
        this.runningAgents.delete(agentId);
        this.abortControllers.delete(agentId);
        this.saveState().catch(err => logger.error({ err }, 'Failed to save state'));
      });

    logger.info({ agentId, skillName, chatId: options.chatId }, 'Started skill agent');
    return agentId;
  }

  /**
   * Run a skill agent in the background.
   */
  private async runAgentInBackground(
    agentId: string,
    options: StartSkillAgentOptions,
    signal: AbortSignal
  ): Promise<string> {
    // Use AgentFactory to create the skill agent with proper configuration
    const skillName = path.basename(options.skillPath, '.md').replace('/SKILL', '');
    const agent = await AgentFactory.createSkillAgent(skillName) as SkillAgent;

    this.runningAgents.set(agentId, agent);
    agent.initialize();

    const executeOptions: SkillAgentExecuteOptions = {
      templateVars: options.templateVars,
    };

    // Collect all responses
    const responses: string[] = [];

    try {
      for await (const message of agent.executeWithContext(executeOptions)) {
        if (signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        if (message.content) {
          // Handle both string and ContentBlock[] types
          const content = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
          responses.push(content);
        }
      }

      // Return summary of responses
      return responses.length > 0
        ? responses.join('\n\n').slice(0, 1000) // Limit result size
        : 'Completed with no output';
    } finally {
      this.runningAgents.delete(agentId);
    }
  }

  /**
   * Stop a running skill agent.
   *
   * @param agentId - Agent ID to stop
   * @returns True if agent was stopped, false if not found or not running
   */
  async stop(agentId: string): Promise<boolean> {
    const info = this.agents.get(agentId);
    if (!info) {
      return false;
    }

    if (info.status !== 'running') {
      return false;
    }

    const abortController = this.abortControllers.get(agentId);
    if (abortController) {
      abortController.abort();
    }

    info.status = 'stopped';
    info.endedAt = new Date().toISOString();

    await this.saveState();

    logger.info({ agentId }, 'Stopped skill agent');
    return true;
  }

  /**
   * Get information about a specific agent.
   *
   * @param agentId - Agent ID
   * @returns Agent info or undefined if not found
   */
  get(agentId: string): SkillAgentInfo | undefined {
    return this.agents.get(agentId);
  }

  /**
   * List all agents.
   *
   * @param filter - Optional status filter
   * @returns List of agent info
   */
  list(filter?: { status?: SkillAgentStatus }): SkillAgentInfo[] {
    const agents = Array.from(this.agents.values());

    if (filter?.status) {
      return agents.filter(a => a.status === filter.status);
    }

    return agents;
  }

  /**
   * List running agents.
   */
  listRunning(): SkillAgentInfo[] {
    return this.list({ status: 'running' });
  }

  /**
   * Clear completed/failed/stopped agents from history.
   */
  async clearHistory(): Promise<number> {
    const toDelete = Array.from(this.agents.entries())
      .filter(([, info]) => info.status !== 'running')
      .map(([id]) => id);

    for (const id of toDelete) {
      this.agents.delete(id);
    }

    await this.saveState();

    logger.info({ count: toDelete.length }, 'Cleared agent history');
    return toDelete.length;
  }
}
