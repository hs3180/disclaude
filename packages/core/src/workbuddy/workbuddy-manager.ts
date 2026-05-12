/**
 * WorkBuddyManager — Server-side management of WorkBuddy registrations.
 *
 * Tracks connected WorkBuddy instances, manages health checks,
 * and routes commands to the appropriate WorkBuddy.
 *
 * @see Issue #3442
 */

import { createLogger } from '../utils/logger.js';
import type {
  WorkBuddyConfig,
  WorkBuddyProjectConfig,
  WorkBuddyRegistration,
  WorkBuddyStatus,
  WorkBuddyCommand,
  WorkBuddyCommandResult,
} from './types.js';

const logger = createLogger('WorkBuddyManager');

/**
 * Callbacks for WorkBuddy command/result communication.
 * Injected via options to decouple from transport layer.
 */
export interface WorkBuddyTransport {
  /** Send a command to a WorkBuddy. Throws if delivery fails. */
  sendCommand(projectKey: string, command: WorkBuddyCommand): Promise<void>;
}

/**
 * WorkBuddyManager options.
 */
export interface WorkBuddyManagerOptions {
  /** WorkBuddy configuration from disclaude.config.yaml */
  config?: WorkBuddyConfig;
  /** Transport for sending commands to WorkBuddys */
  transport?: WorkBuddyTransport;
  /** Health check interval in seconds (default: 30) */
  healthCheckIntervalSec?: number;
}

/**
 * Manages WorkBuddy registrations and command routing on the server side.
 *
 * Usage:
 * ```typescript
 * const manager = new WorkBuddyManager({ config, transport });
 * manager.register('my-project', 'online');
 * await manager.sendCommand('my-project', command);
 * ```
 */
export class WorkBuddyManager {
  private readonly registrations = new Map<string, WorkBuddyRegistration>();
  private readonly config: WorkBuddyConfig | undefined;
  private readonly transport: WorkBuddyTransport | undefined;
  private readonly defaultHealthCheckIntervalSec: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: WorkBuddyManagerOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.defaultHealthCheckIntervalSec = options.healthCheckIntervalSec ?? 30;
  }

  /**
   * Start periodic health checks for all registered WorkBuddys.
   */
  startHealthChecks(): void {
    this.stopHealthChecks();
    this.healthCheckTimer = setInterval(
      () => this.checkAllHealth(),
      this.defaultHealthCheckIntervalSec * 1000,
    );
    logger.info({ intervalSec: this.defaultHealthCheckIntervalSec }, 'Health checks started');
  }

  /**
   * Stop periodic health checks.
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
      logger.info('Health checks stopped');
    }
  }

  /**
   * Register a WorkBuddy instance.
   *
   * @param projectKey - Project key from config
   * @param status - Initial connection status
   * @returns The registration record
   */
  register(projectKey: string, status: WorkBuddyStatus = 'online'): WorkBuddyRegistration {
    const now = new Date().toISOString();
    const registration: WorkBuddyRegistration = {
      projectKey,
      status,
      registeredAt: now,
      lastHealthCheck: now,
    };
    this.registrations.set(projectKey, registration);
    logger.info({ projectKey, status }, 'WorkBuddy registered');
    return registration;
  }

  /**
   * Deregister a WorkBuddy instance.
   *
   * @param projectKey - Project key to deregister
   * @returns true if the WorkBuddy was found and removed
   */
  deregister(projectKey: string): boolean {
    const removed = this.registrations.delete(projectKey);
    if (removed) {
      logger.info({ projectKey }, 'WorkBuddy deregistered');
    }
    return removed;
  }

  /**
   * Update a WorkBuddy's status.
   *
   * @param projectKey - Project key to update
   * @param status - New status
   * @returns true if the WorkBuddy was found and updated
   */
  updateStatus(projectKey: string, status: WorkBuddyStatus): boolean {
    const reg = this.registrations.get(projectKey);
    if (!reg) {
      logger.warn({ projectKey }, 'Cannot update status: WorkBuddy not registered');
      return false;
    }
    reg.status = status;
    reg.lastHealthCheck = new Date().toISOString();
    logger.debug({ projectKey, status }, 'WorkBuddy status updated');
    return true;
  }

  /**
   * Get a WorkBuddy's registration info.
   *
   * @param projectKey - Project key to look up
   * @returns Registration info or undefined
   */
  getRegistration(projectKey: string): WorkBuddyRegistration | undefined {
    return this.registrations.get(projectKey);
  }

  /**
   * Get all registered WorkBuddys.
   */
  getAllRegistrations(): WorkBuddyRegistration[] {
    return Array.from(this.registrations.values());
  }

  /**
   * Get project configuration for a given project key.
   *
   * @param projectKey - Project key from config
   * @returns Project config or undefined
   */
  getProjectConfig(projectKey: string): WorkBuddyProjectConfig | undefined {
    return this.config?.projects[projectKey];
  }

  /**
   * Check if a WorkBuddy is available (online and not busy).
   *
   * @param projectKey - Project key to check
   * @returns true if available
   */
  isAvailable(projectKey: string): boolean {
    const reg = this.registrations.get(projectKey);
    return reg?.status === 'online';
  }

  /**
   * Send a command to a registered WorkBuddy.
   *
   * @param projectKey - Target WorkBuddy's project key
   * @param command - Command to send
   * @throws Error if WorkBuddy is not registered, not available, or transport fails
   */
  async sendCommand(projectKey: string, command: WorkBuddyCommand): Promise<void> {
    const reg = this.registrations.get(projectKey);
    if (!reg) {
      throw new Error(`WorkBuddy not registered: ${projectKey}`);
    }
    if (reg.status !== 'online') {
      throw new Error(`WorkBuddy not available (status: ${reg.status}): ${projectKey}`);
    }
    if (!this.transport) {
      throw new Error('No transport configured for WorkBuddy commands');
    }

    reg.status = 'busy';
    reg.activeCommandId = command.id;
    reg.lastCommandAt = new Date().toISOString();

    try {
      await this.transport.sendCommand(projectKey, command);
      logger.info({ projectKey, commandId: command.id, type: command.type }, 'Command sent');
    } catch (error) {
      // Revert status on transport failure
      reg.status = 'error';
      reg.activeCommandId = undefined;
      throw error;
    }
  }

  /**
   * Handle a command result from a WorkBuddy.
   * Updates the registration status and clears the active command.
   *
   * @param result - Command result from WorkBuddy
   */
  handleResult(result: WorkBuddyCommandResult): void {
    for (const [, reg] of this.registrations) {
      if (reg.activeCommandId === result.commandId) {
        reg.status = result.status === 'error' ? 'error' : 'online';
        reg.activeCommandId = undefined;
        reg.lastHealthCheck = new Date().toISOString();
        logger.info(
          { projectKey: reg.projectKey, commandId: result.commandId, status: result.status },
          'Command result received',
        );
        return;
      }
    }
    logger.warn({ commandId: result.commandId }, 'Result for unknown command');
  }

  /**
   * Check health of all registered WorkBuddys.
   * Stale registrations (no health check for 2x interval) are marked offline.
   */
  private checkAllHealth(): void {
    const now = Date.now();
    const staleThresholdMs = this.defaultHealthCheckIntervalSec * 2 * 1000;

    for (const [key, reg] of this.registrations) {
      const lastCheck = new Date(reg.lastHealthCheck).getTime();
      const ageMs = now - lastCheck;

      if (ageMs > staleThresholdMs && reg.status !== 'offline') {
        logger.warn({ projectKey: key, ageMs }, 'WorkBuddy health check stale, marking offline');
        reg.status = 'offline';
      }
    }
  }
}
