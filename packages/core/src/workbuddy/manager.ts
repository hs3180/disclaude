/**
 * WorkBuddyManager - Manages WorkBuddy agent connections and lifecycle.
 *
 * Tracks WorkBuddy project configurations, maintains client connections,
 * and performs periodic health checks. Follows the same initialization
 * pattern as the Scheduler system (non-fatal startup, DI-based callbacks).
 *
 * @see Issue #3442
 * @module @disclaude/core/workbuddy
 */

import { createLogger } from '../utils/logger.js';
import type { WorkBuddyConfig, WorkBuddyProjectConfig } from '../config/types.js';
import { WorkBuddyClient } from './client.js';
import type { A2ACommand, A2AResponse, WorkBuddyCallbacks, WorkBuddyHealth, WorkBuddyStatus } from './types.js';

const logger = createLogger('WorkBuddyManager');

/** Default health check interval (30 seconds) */
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Default command timeout (60 seconds) */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Managed WorkBuddy instance — tracks client, config, and health state.
 */
interface ManagedWorkBuddy {
  /** Project key */
  projectKey: string;
  /** Project configuration */
  config: WorkBuddyProjectConfig;
  /** HTTP client for this WorkBuddy */
  client: WorkBuddyClient;
  /** Current health status */
  status: WorkBuddyStatus;
  /** Last known health info */
  lastHealth: WorkBuddyHealth | null;
}

/**
 * WorkBuddyManager options.
 */
export interface WorkBuddyManagerOptions {
  /** WorkBuddy configuration from disclaude.config.yaml */
  config: WorkBuddyConfig;
  /** Callbacks for sending messages to chats */
  callbacks: WorkBuddyCallbacks;
}

/**
 * Manages WorkBuddy agent connections and lifecycle.
 *
 * Responsibilities:
 * - Initialize WorkBuddy clients for each configured project
 * - Periodic health checks
 * - Command routing: route A2A commands to the correct WorkBuddy
 * - Status reporting
 *
 * @example
 * ```typescript
 * const manager = new WorkBuddyManager({
 *   config: Config.getWorkBuddyConfig()!,
 *   callbacks: { sendMessage: async (chatId, msg) => { ... } },
 * });
 *
 * // Start health check loop
 * manager.start();
 *
 * // Send a command to a project's WorkBuddy
 * const response = await manager.sendCommand('my-project', {
 *   type: 'execute',
 *   payload: 'npm run build',
 * });
 *
 * // Stop health checks and cleanup
 * manager.stop();
 * ```
 */
export class WorkBuddyManager {
  private readonly config: WorkBuddyConfig;
  private readonly callbacks: WorkBuddyCallbacks;
  private readonly buddies: Map<string, ManagedWorkBuddy> = new Map();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: WorkBuddyManagerOptions) {
    this.config = options.config;
    this.callbacks = options.callbacks;
  }

  /**
   * Start the WorkBuddy manager.
   * Initializes clients for all configured projects and starts health checks.
   */
  start(): void {
    if (this.running) {
      logger.warn('WorkBuddyManager already running');
      return;
    }

    const projects = this.config.projects ?? {};
    const projectKeys = Object.keys(projects);

    if (projectKeys.length === 0) {
      logger.info('No WorkBuddy projects configured');
      return;
    }

    // Initialize a client for each project
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const {authToken} = this.config;

    for (const [projectKey, projectConfig] of Object.entries(projects)) {
      const client = new WorkBuddyClient({
        endpoint: projectConfig.cwd, // cwd serves as endpoint identifier in config
        authToken,
        timeoutMs,
      });

      this.buddies.set(projectKey, {
        projectKey,
        config: projectConfig,
        client,
        status: 'unknown',
        lastHealth: null,
      });

      logger.info(
        { projectKey, chatId: projectConfig.chatId, tools: projectConfig.tools },
        'Registered WorkBuddy project',
      );
    }

    // Start periodic health checks
    const healthCheckIntervalMs = this.config.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.healthCheckTimer = setInterval(
      () => this.performHealthChecks(),
      healthCheckIntervalMs,
    );

    this.running = true;
    logger.info({ projectCount: projectKeys.length }, 'WorkBuddyManager started');
  }

  /**
   * Stop the WorkBuddy manager.
   * Stops health checks and clears all managed clients.
   */
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.buddies.clear();
    this.running = false;
    logger.info('WorkBuddyManager stopped');
  }

  /**
   * Send an A2A command to a specific project's WorkBuddy.
   *
   * @param projectKey - Target project key
   * @param type - Command type
   * @param payload - Command payload
   * @returns Response from WorkBuddy, or error response if unavailable
   */
  async sendCommand(
    projectKey: string,
    type: A2ACommand['type'],
    payload: string,
  ): Promise<A2AResponse> {
    const buddy = this.buddies.get(projectKey);
    if (!buddy) {
      logger.warn({ projectKey }, 'No WorkBuddy configured for project');
      return {
        commandId: `err-${Date.now()}`,
        success: false,
        error: `No WorkBuddy configured for project: ${projectKey}`,
        completedAt: new Date().toISOString(),
      };
    }

    const command: A2ACommand = {
      id: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      payload,
      projectKey,
      createdAt: new Date().toISOString(),
    };

    try {
      const response = await buddy.client.sendCommand(command);

      // Notify the bound chat of the result
      if (buddy.config.chatId) {
        if (response.success) {
          await this.callbacks.sendMessage(
            buddy.config.chatId,
            `✅ WorkBuddy [${projectKey}] 命令完成: ${response.payload ?? '(无输出)'}`,
          );
        } else {
          await this.callbacks.sendMessage(
            buddy.config.chatId,
            `❌ WorkBuddy [${projectKey}] 命令失败: ${response.error ?? '未知错误'}`,
          );
        }
      }

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, projectKey }, 'WorkBuddy command failed');

      // Notify bound chat of the error
      if (buddy.config.chatId) {
        await this.callbacks.sendMessage(
          buddy.config.chatId,
          `❌ WorkBuddy [${projectKey}] 通信失败: ${message}`,
        );
      }

      return {
        commandId: command.id,
        success: false,
        error: message,
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Get the health status of all managed WorkBuddy agents.
   *
   * @returns Map of project key → health status
   */
  getHealthStatus(): Map<string, WorkBuddyHealth> {
    const result = new Map<string, WorkBuddyHealth>();
    for (const [key, buddy] of this.buddies) {
      result.set(key, buddy.lastHealth ?? {
        projectKey: key,
        status: buddy.status,
        lastCheckedAt: new Date().toISOString(),
      });
    }
    return result;
  }

  /**
   * Get all configured project keys.
   *
   * @returns Array of project keys
   */
  getProjectKeys(): string[] {
    return Array.from(this.buddies.keys());
  }

  /**
   * Get a project's configuration.
   *
   * @param projectKey - Project key to look up
   * @returns Project configuration or undefined
   */
  getProjectConfig(projectKey: string): WorkBuddyProjectConfig | undefined {
    return this.buddies.get(projectKey)?.config;
  }

  /**
   * Check if the manager is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Perform health checks on all managed WorkBuddy agents.
   */
  private async performHealthChecks(): Promise<void> {
    for (const [projectKey, buddy] of this.buddies) {
      try {
        const health = await buddy.client.checkHealth(projectKey);
        const previousStatus = buddy.status;
        buddy.status = health.status;
        buddy.lastHealth = health;

        // Log status transitions
        if (previousStatus !== health.status) {
          logger.info(
            { projectKey, previousStatus, newStatus: health.status },
            'WorkBuddy status changed',
          );
        }
      } catch {
        buddy.status = 'offline';
      }
    }
  }
}
