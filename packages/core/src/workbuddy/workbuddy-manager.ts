/**
 * WorkBuddyManager — manages WorkBuddy local Agent process lifecycle.
 *
 * Spawns, monitors, and stops WorkBuddy processes. Each WorkBuddy is a
 * Claude Code Agent subprocess bound to a specific project directory.
 *
 * Phase 1: Process lifecycle management (spawn, health check, stop).
 * Future: A2A message integration for bidirectional command/response.
 *
 * @see Issue #3442
 */

import { spawn, type ChildProcess } from 'child_process';
import { createLogger, type Logger } from '../utils/logger.js';
import type {
  WorkBuddyConfig,
  WorkBuddyProjectConfig,
  WorkBuddyInstance,
  WorkBuddyStatus,
  WorkBuddyCallbacks,
} from './types.js';

const defaultLogger = createLogger('WorkBuddyManager');

/** Default health check interval: 30 seconds */
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Default graceful shutdown timeout: 5 seconds */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Manages the lifecycle of WorkBuddy Agent processes.
 *
 * Usage:
 * ```typescript
 * const manager = new WorkBuddyManager({
 *   config: { projects: { myApp: { cwd: '/path/to/project' } } },
 *   callbacks: {
 *     onStatusChange: (name, status) => console.log(`${name}: ${status}`),
 *     onResponse: (name, resp) => console.log(`${name} responded`, resp),
 *   },
 * });
 *
 * await manager.start('myApp');
 * const instances = manager.listInstances();
 * await manager.stop('myApp');
 * ```
 */
export class WorkBuddyManager {
  private readonly config: WorkBuddyConfig;
  private readonly callbacks?: WorkBuddyCallbacks;
  private readonly log: Logger;
  private readonly healthCheckIntervalMs: number;
  private readonly shutdownTimeoutMs: number;

  /** Running processes keyed by project name */
  private readonly processes = new Map<string, ChildProcess>();

  /** Instance state keyed by project name */
  private readonly instances = new Map<string, WorkBuddyInstance>();

  /** Health check timers keyed by project name */
  private readonly healthTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(options: {
    config: WorkBuddyConfig;
    callbacks?: WorkBuddyCallbacks;
    logger?: Logger;
    healthCheckIntervalMs?: number;
    shutdownTimeoutMs?: number;
  }) {
    this.config = options.config;
    this.callbacks = options.callbacks;
    this.log = options.logger ?? defaultLogger;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  /**
   * Start a WorkBuddy process for the given project.
   *
   * Spawns a Claude Code CLI subprocess in the project's working directory.
   * The subprocess inherits the project's configured environment variables.
   *
   * @param projectName - Name of the project (must exist in config)
   * @returns The WorkBuddy instance state
   * @throws Error if the project is not configured or already running
   */
  start(projectName: string): WorkBuddyInstance {
    const projectConfig = this.config.projects[projectName];
    if (!projectConfig) {
      throw new Error(`WorkBuddy project "${projectName}" not found in config`);
    }

    const existing = this.processes.get(projectName);
    if (existing && !existing.killed) {
      throw new Error(`WorkBuddy project "${projectName}" is already running (pid ${existing.pid})`);
    }

    this.log.info({ projectName, cwd: projectConfig.cwd }, 'Starting WorkBuddy process');

    const instance = this.createInstance(projectName);
    this.instances.set(projectName, instance);
    this.updateStatus(projectName, 'starting');

    try {
      const proc = this.spawnProcess(projectName, projectConfig);
      this.processes.set(projectName, proc);

      instance.pid = proc.pid;
      instance.startedAt = new Date().toISOString();
      this.updateStatus(projectName, 'ready');

      proc.on('exit', (code, signal) => {
        this.log.info({ projectName, code, signal }, 'WorkBuddy process exited');
        this.processes.delete(projectName);
        this.clearHealthCheck(projectName);
        if (this.instances.get(projectName)?.status !== 'stopping') {
          this.updateStatus(projectName, code === 0 ? 'stopped' : 'error');
          if (code !== 0) {
            const inst = this.instances.get(projectName);
            if (inst) {
              inst.lastError = `Process exited with code ${code}, signal ${signal}`;
            }
          }
        } else {
          this.updateStatus(projectName, 'stopped');
        }
      });

      proc.on('error', (err) => {
        this.log.error({ err, projectName }, 'WorkBuddy process error');
        this.processes.delete(projectName);
        this.clearHealthCheck(projectName);
        const inst = this.instances.get(projectName);
        if (inst) {
          inst.lastError = err.message;
        }
        this.updateStatus(projectName, 'error');
      });

      // Start health check
      this.startHealthCheck(projectName);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err, projectName }, 'Failed to start WorkBuddy process');
      instance.lastError = message;
      this.updateStatus(projectName, 'error');
    }

    return { ...instance };
  }

  /**
   * Stop a WorkBuddy process gracefully.
   *
   * Sends SIGTERM first, then SIGKILL after the shutdown timeout.
   *
   * @param projectName - Name of the project to stop
   */
  async stop(projectName: string): Promise<void> {
    const proc = this.processes.get(projectName);
    if (!proc || proc.killed) {
      this.log.debug({ projectName }, 'WorkBuddy process not running, nothing to stop');
      return;
    }

    this.log.info({ projectName }, 'Stopping WorkBuddy process');
    this.updateStatus(projectName, 'stopping');

    // Clear health check timer
    this.clearHealthCheck(projectName);

    // Graceful shutdown with timeout
    const exitPromise = new Promise<void>((resolve) => {
      proc.once('exit', () => {
        resolve();
      });
    });

    proc.kill('SIGTERM');

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!proc.killed) {
          this.log.warn({ projectName }, 'WorkBuddy did not exit gracefully, sending SIGKILL');
          proc.kill('SIGKILL');
        }
        resolve();
      }, this.shutdownTimeoutMs);
    });

    await Promise.race([exitPromise, timeoutPromise]);
    this.processes.delete(projectName);
    this.updateStatus(projectName, 'stopped');
  }

  /**
   * Stop all running WorkBuddy processes.
   */
  async stopAll(): Promise<void> {
    const names = Array.from(this.processes.keys());
    await Promise.all(names.map((name) => this.stop(name)));
  }

  /**
   * Get the instance state for a project.
   *
   * @param projectName - Project name to look up
   * @returns A copy of the instance state, or undefined if not tracked
   */
  getInstance(projectName: string): WorkBuddyInstance | undefined {
    const instance = this.instances.get(projectName);
    return instance ? { ...instance } : undefined;
  }

  /**
   * List all tracked WorkBuddy instances.
   *
   * @returns Array of instance states (copies)
   */
  listInstances(): WorkBuddyInstance[] {
    return Array.from(this.instances.values()).map((i) => ({ ...i }));
  }

  /**
   * Get the project config for a project name.
   */
  getProjectConfig(projectName: string): WorkBuddyProjectConfig | undefined {
    return this.config.projects[projectName];
  }

  /**
   * List all configured project names.
   */
  listProjectNames(): string[] {
    return Object.keys(this.config.projects);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Private Helpers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Spawn a Claude Code CLI subprocess for the given project.
   */
  private spawnProcess(projectName: string, config: WorkBuddyProjectConfig): ChildProcess {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...config.env,
    };

    // Build CLI args — run Claude Code in the project directory
    // Using 'claude' CLI with --print flag for non-interactive mode
    // and piping commands through stdin
    const args: string[] = [];

    if (config.model) {
      args.push('--model', config.model);
    }

    if (config.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    }

    const proc = spawn('claude', args, {
      cwd: config.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    // Capture stderr for debugging
    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        this.log.debug({ projectName, stderr: msg }, 'WorkBuddy stderr');
      }
    });

    return proc;
  }

  /**
   * Create a new WorkBuddyInstance with default values.
   */
  private createInstance(projectName: string): WorkBuddyInstance {
    return {
      projectName,
      status: 'stopped',
    };
  }

  /**
   * Update instance status and notify via callback.
   */
  private updateStatus(projectName: string, status: WorkBuddyStatus): void {
    const instance = this.instances.get(projectName);
    if (instance) {
      instance.status = status;
      instance.lastHeartbeatAt = status === 'ready' ? new Date().toISOString() : instance.lastHeartbeatAt;
    }

    this.log.debug({ projectName, status }, 'WorkBuddy status changed');
    this.callbacks?.onStatusChange(projectName, status);
  }

  /**
   * Start periodic health check for a project's process.
   */
  private startHealthCheck(projectName: string): void {
    // Clear any existing timer
    const existing = this.healthTimers.get(projectName);
    if (existing) {
      clearInterval(existing);
    }

    const timer = setInterval(() => {
      this.checkHealth(projectName);
    }, this.healthCheckIntervalMs);

    this.healthTimers.set(projectName, timer);
  }

  /**
   * Check if a WorkBuddy process is still alive.
   */
  private checkHealth(projectName: string): void {
    const proc = this.processes.get(projectName);
    const instance = this.instances.get(projectName);

    if (!proc || !instance) {
      return;
    }

    if (proc.killed || proc.exitCode !== null) {
      this.log.warn({ projectName, exitCode: proc.exitCode }, 'WorkBuddy process died');
      instance.lastError = `Process exited unexpectedly (code: ${proc.exitCode})`;
      this.updateStatus(projectName, 'error');
      this.clearHealthCheck(projectName);
      return;
    }

    // Update heartbeat
    instance.lastHeartbeatAt = new Date().toISOString();
  }

  /**
   * Clear health check timer for a project.
   */
  private clearHealthCheck(projectName: string): void {
    const timer = this.healthTimers.get(projectName);
    if (timer) {
      clearInterval(timer);
      this.healthTimers.delete(projectName);
    }
  }
}
