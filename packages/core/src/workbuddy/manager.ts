/**
 * WorkBuddyManager — manages WorkBuddy instances and command routing.
 *
 * Phase 1 (Issue #3442): Basic framework — config-driven registry, health check,
 * and command execution via HTTP.
 *
 * WorkBuddy is a lightweight Agent process on the user's local machine.
 * This manager tracks configured WorkBuddy instances, checks their health,
 * and routes commands to the appropriate instance.
 *
 * @see Issue #3442
 */

import { createLogger } from '../utils/logger.js';
import type {
  WorkBuddyProjectConfig,
  WorkBuddyInstance,
  WorkBuddyStatus,
  WorkBuddyCommand,
  WorkBuddyCommandResult,
  WorkBuddyManagerOptions,
  WorkBuddyResult,
} from './types.js';

const logger = createLogger('WorkBuddyManager');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WorkBuddyManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages WorkBuddy instances with health checking and command routing.
 *
 * Lifecycle:
 * 1. Construct with config from disclaude.config.yaml
 * 2. Instances are registered from config automatically
 * 3. Use `checkHealth()` to verify connectivity
 * 4. Use `executeCommand()` to send commands to WorkBuddy
 */
export class WorkBuddyManager {
  /** Map of project name → WorkBuddyInstance */
  private readonly instances: Map<string, WorkBuddyInstance> = new Map();

  /** Map of chatId → project name for message routing */
  private readonly chatIdIndex: Map<string, string> = new Map();

  constructor(options: WorkBuddyManagerOptions) {
    if (options.config?.projects) {
      for (const [name, projectConfig] of Object.entries(options.config.projects)) {
        this.registerProject(name, projectConfig);
      }
    }
    logger.info({ count: this.instances.size }, 'WorkBuddyManager initialized');
  }

  // ───────────────────────────────────────────
  // Registry Methods
  // ───────────────────────────────────────────

  /**
   * Register a WorkBuddy project from config.
   */
  private registerProject(name: string, config: WorkBuddyProjectConfig): void {
    const instance: WorkBuddyInstance = {
      name,
      config,
      status: 'unknown',
    };
    this.instances.set(name, instance);

    // Build chatId → project name index
    if (config.chatId) {
      this.chatIdIndex.set(config.chatId, name);
    }

    logger.debug({ name, endpoint: config.endpoint }, 'Registered WorkBuddy project');
  }

  /**
   * List all registered WorkBuddy instances.
   */
  listInstances(): WorkBuddyInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get a WorkBuddy instance by project name.
   */
  getInstance(name: string): WorkBuddyInstance | undefined {
    return this.instances.get(name);
  }

  /**
   * Find a WorkBuddy instance by chatId.
   */
  getInstanceByChatId(chatId: string): WorkBuddyInstance | undefined {
    const name = this.chatIdIndex.get(chatId);
    if (name) {
      return this.instances.get(name);
    }
    return undefined;
  }

  /**
   * Get the number of registered instances.
   */
  get size(): number {
    return this.instances.size;
  }

  // ───────────────────────────────────────────
  // Health Check
  // ───────────────────────────────────────────

  /**
   * Check health of a specific WorkBuddy instance.
   *
   * Sends an HTTP GET to `{endpoint}/health` and updates the instance status.
   */
  async checkHealth(name: string): Promise<WorkBuddyResult<WorkBuddyStatus>> {
    const instance = this.instances.get(name);
    if (!instance) {
      return { ok: false, error: `WorkBuddy "${name}" not found` };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${instance.config.endpoint}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        instance.status = 'connected';
        instance.lastHealthCheck = new Date().toISOString();
        instance.lastError = undefined;
        logger.debug({ name }, 'WorkBuddy health check passed');
        return { ok: true, data: 'connected' };
      } else {
        instance.status = 'disconnected';
        instance.lastError = `HTTP ${response.status}`;
        logger.warn({ name, status: response.status }, 'WorkBuddy health check failed');
        return { ok: true, data: 'disconnected' };
      }
    } catch (err) {
      instance.status = 'disconnected';
      instance.lastError = err instanceof Error ? err.message : String(err);
      instance.lastHealthCheck = new Date().toISOString();
      logger.debug({ name, err: instance.lastError }, 'WorkBuddy unreachable');
      return { ok: true, data: 'disconnected' };
    }
  }

  /**
   * Check health of all registered WorkBuddy instances.
   */
  async checkAllHealth(): Promise<Record<string, WorkBuddyStatus>> {
    const results: Record<string, WorkBuddyStatus> = {};
    const checks = Array.from(this.instances.keys()).map(async (name) => {
      const result = await this.checkHealth(name);
      results[name] = result.ok ? result.data : 'unknown';
    });
    await Promise.all(checks);
    return results;
  }

  // ───────────────────────────────────────────
  // Command Execution
  // ───────────────────────────────────────────

  /**
   * Execute a command on a WorkBuddy instance.
   *
   * Sends an HTTP POST to `{endpoint}/command` with the command payload.
   */
  async executeCommand(
    name: string,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<WorkBuddyResult<WorkBuddyCommandResult>> {
    const instance = this.instances.get(name);
    if (!instance) {
      return { ok: false, error: `WorkBuddy "${name}" not found` };
    }

    const requestId = `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload: WorkBuddyCommand = { command, args, requestId };

    logger.info({ name, command, requestId }, 'Sending command to WorkBuddy');

    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000); // 60s timeout for commands

      const response = await fetch(`${instance.config.endpoint}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const durationMs = Date.now() - startTime;

      if (response.ok) {
        const result = (await response.json()) as WorkBuddyCommandResult;
        instance.status = 'connected';
        instance.lastHealthCheck = new Date().toISOString();
        logger.info({ name, command, requestId, durationMs, success: result.success }, 'WorkBuddy command completed');
        return {
          ok: true,
          data: { ...result, durationMs },
        };
      } else {
        const errorText = await response.text().catch(() => 'Unknown error');
        instance.status = 'connected';
        instance.lastError = `Command failed: HTTP ${response.status}`;
        logger.warn({ name, command, requestId, status: response.status }, 'WorkBuddy command failed');
        return {
          ok: true,
          data: {
            success: false,
            error: `WorkBuddy returned HTTP ${response.status}: ${errorText}`,
            durationMs,
          },
        };
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      instance.status = 'disconnected';
      instance.lastError = errorMessage;
      logger.error({ name, command, requestId, err: errorMessage, durationMs }, 'WorkBuddy command error');
      return {
        ok: false,
        error: `Failed to reach WorkBuddy "${name}": ${errorMessage}`,
      };
    }
  }

  // ───────────────────────────────────────────
  // Lookup Helpers
  // ───────────────────────────────────────────

  /**
   * Find the WorkBuddy name for a given chatId.
   * Used for routing user messages from a bound chat to the correct WorkBuddy.
   */
  findNameForChatId(chatId: string): string | undefined {
    return this.chatIdIndex.get(chatId);
  }

  /**
   * Get all project names.
   */
  getProjectNames(): string[] {
    return Array.from(this.instances.keys());
  }
}
