/**
 * WorkBuddy Manager — process lifecycle management and command routing.
 *
 * Manages WorkBuddy child processes: starting, stopping, health-checking, and
 * routing commands from the disclaude message bus to the appropriate WorkBuddy
 * instance based on chatId → project binding.
 *
 * @module core/workbuddy/manager
 * @see Issue #3442
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createLogger } from '../utils/logger.js';
import type {
  WorkBuddyConfig,
  WorkBuddyProjectConfig,
  WorkBuddyProcess,
  WorkBuddyChatRouting,
  WorkBuddyCommand,
  WorkBuddyResult,
  WorkBuddyHealth,
} from './types.js';

const logger = createLogger('WorkBuddy');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Health-check interval in milliseconds */
const HEALTH_CHECK_INTERVAL_MS = 60_000;

/** Maximum number of consecutive health-check failures before marking error */
const MAX_HEALTH_FAILURES = 3;

/** Grace period after spawn before first health check (ms) */
const STARTUP_GRACE_PERIOD_MS = 5_000;

// ---------------------------------------------------------------------------
// WorkBuddyManager
// ---------------------------------------------------------------------------

/**
 * Manages WorkBuddy process lifecycle and command routing.
 *
 * Reads project configuration from `workbuddy.projects` in
 * `disclaude.config.yaml` and manages the corresponding child processes.
 *
 * @example
 * ```typescript
 * const manager = new WorkBuddyManager(config);
 * await manager.startAll();
 *
 * // Route a command to the WorkBuddy bound to a chatId
 * const result = await manager.sendCommand(chatId, {
 *   type: 'preview',
 *   payload: {},
 * });
 * ```
 */
export class WorkBuddyManager {
  private readonly processes = new Map<string, WorkBuddyProcess>();
  private readonly childProcesses = new Map<string, ChildProcess>();
  private readonly chatRouting: WorkBuddyChatRouting;
  private readonly config: WorkBuddyConfig;
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor(config: WorkBuddyConfig) {
    this.config = config;
    this.chatRouting = new Map();

    // Build chatId → projectName routing table from config
    for (const [projectName, projectConfig] of Object.entries(config.projects)) {
      this.chatRouting.set(projectConfig.chatId, projectName);
      logger.info({ projectName, chatId: projectConfig.chatId, cwd: projectConfig.cwd }, 'Registered WorkBuddy project');
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start all configured WorkBuddy processes.
   */
  async startAll(): Promise<void> {
    const projectNames = Object.keys(this.config.projects);
    if (projectNames.length === 0) {
      logger.info('No WorkBuddy projects configured');
      return;
    }

    logger.info({ projects: projectNames }, 'Starting WorkBuddy processes');
    for (const name of projectNames) {
      await this.start(name);
    }

    this.startHealthChecks();
  }

  /**
   * Stop all running WorkBuddy processes.
   */
  async stopAll(): Promise<void> {
    logger.info('Stopping all WorkBuddy processes');
    this.stopHealthChecks();

    const stopPromises: Promise<void>[] = [];
    for (const name of this.processes.keys()) {
      stopPromises.push(this.stop(name));
    }
    await Promise.allSettled(stopPromises);
  }

  /**
   * Start a single WorkBuddy process by project name.
   */
  async start(projectName: string): Promise<void> {
    const projectConfig = this.config.projects[projectName];
    if (!projectConfig) {
      throw new Error(`WorkBuddy project "${projectName}" not found in config`);
    }

    const existing = this.processes.get(projectName);
    if (existing && existing.status === 'running') {
      logger.warn({ projectName }, 'WorkBuddy process already running');
      return;
    }

    const socketPath = this.generateSocketPath(projectName);
    const processEntry: WorkBuddyProcess = {
      projectName,
      status: 'starting',
      cwd: projectConfig.cwd,
      chatId: projectConfig.chatId,
      socketPath,
    };

    this.processes.set(projectName, processEntry);
    logger.info({ projectName, cwd: projectConfig.cwd }, 'Starting WorkBuddy process');

    try {
      await this.spawnProcess(projectName, projectConfig, socketPath);
      processEntry.status = 'running';
      processEntry.startedAt = new Date().toISOString();
      logger.info({ projectName, pid: processEntry.pid }, 'WorkBuddy process started');
    } catch (err) {
      processEntry.status = 'error';
      processEntry.errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ projectName, err: processEntry.errorMessage }, 'Failed to start WorkBuddy process');
    }
  }

  /**
   * Stop a single WorkBuddy process by project name.
   */
  async stop(projectName: string): Promise<void> {
    const entry = this.processes.get(projectName);
    if (!entry) {
      logger.warn({ projectName }, 'WorkBuddy process not found');
      return;
    }

    if (entry.status === 'stopped') {
      return;
    }

    entry.status = 'stopping';
    logger.info({ projectName }, 'Stopping WorkBuddy process');

    const child = this.childProcesses.get(projectName);
    if (child && !child.killed) {
      child.kill('SIGTERM');

      // Give the process a grace period to exit cleanly
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
          resolve();
        }, 5_000);

        child.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    this.childProcesses.delete(projectName);
    entry.status = 'stopped';
    this.cleanupSocket(entry.socketPath);
    logger.info({ projectName }, 'WorkBuddy process stopped');
  }

  // -------------------------------------------------------------------------
  // Command Routing
  // -------------------------------------------------------------------------

  /**
   * Send a command to the WorkBuddy instance bound to the given chatId.
   *
   * Returns the result from the WorkBuddy process, or an error result if no
   * WorkBuddy is bound to the chatId or the process is not running.
   */
  sendCommand(chatId: string, command: WorkBuddyCommand): Promise<WorkBuddyResult> {
    const projectName = this.chatRouting.get(chatId);
    if (!projectName) {
      return { success: false, error: `No WorkBuddy project bound to chatId ${chatId}` };
    }

    const entry = this.processes.get(projectName);
    if (!entry || entry.status !== 'running') {
      return { success: false, error: `WorkBuddy process "${projectName}" is not running (status: ${entry?.status ?? 'unknown'})` };
    }

    return this.sendCommandToProcess(projectName, command);
  }

  /**
   * Send a command to a specific WorkBuddy process by project name.
   */
  sendCommandToProcess(projectName: string, command: WorkBuddyCommand): Promise<WorkBuddyResult> {
    const entry = this.processes.get(projectName);
    if (!entry) {
      return { success: false, error: `WorkBuddy process "${projectName}" not found` };
    }

    if (entry.status !== 'running') {
      return { success: false, error: `WorkBuddy process "${projectName}" is not running (status: ${entry.status})` };
    }

    // Phase 1: communicate via IPC (send command to child process via Unix socket)
    // The actual IPC client implementation will be added when the WorkBuddy
    // agent binary is built. For now, we return a placeholder indicating the
    // command was routed but the WorkBuddy agent is not yet available.
    logger.info(
      { projectName, commandType: command.type, socketPath: entry.socketPath },
      'Routing command to WorkBuddy process',
    );

    // TODO: Implement actual IPC communication when WorkBuddy agent binary is ready.
    // This will use UnixSocketIpcClient to send the command and await the response.
    return {
      success: false,
      error: 'WorkBuddy agent binary not yet available. IPC communication will be implemented in a follow-up phase.',
    };
  }

  // -------------------------------------------------------------------------
  // Status & Health
  // -------------------------------------------------------------------------

  /**
   * Get the status of all managed WorkBuddy processes.
   */
  getStatus(): WorkBuddyProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get the status of a single WorkBuddy process.
   */
  getProcessStatus(projectName: string): WorkBuddyProcess | undefined {
    return this.processes.get(projectName);
  }

  /**
   * Perform a health check on all running processes.
   */
  healthCheck(): Promise<Map<string, WorkBuddyHealth>> {
    const results = new Map<string, WorkBuddyHealth>();

    for (const [projectName, entry] of this.processes) {
      if (entry.status !== 'running') {continue;}

      // TODO: Replace with actual IPC ping when WorkBuddy agent binary is ready
      const healthy = this.isProcessAlive(projectName);
      results.set(projectName, {
        healthy,
        projectName,
        cwd: entry.cwd,
      });
    }

    return results;
  }

  /**
   * Look up the project name bound to a chatId.
   */
  getProjectForChat(chatId: string): string | undefined {
    return this.chatRouting.get(chatId);
  }

  /**
   * Get the chat routing table (chatId → projectName).
   */
  getChatRouting(): ReadonlyMap<string, string> {
    return this.chatRouting;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Spawn a WorkBuddy child process.
   *
   * The child process is expected to:
   * 1. Start a Unix socket IPC server on `socketPath`
   * 2. Read project-level CLAUDE.md from `projectConfig.cwd`
   * 3. Accept and execute commands via IPC
   *
   * For Phase 1, we spawn a placeholder that demonstrates the process
   * management lifecycle. The actual agent binary will be implemented later.
   */
  private async spawnProcess(
    projectName: string,
    projectConfig: WorkBuddyProjectConfig,
    socketPath: string,
  ): Promise<void> {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...projectConfig.env,
      DISCLAUDE_WORKBUDDY_PROJECT: projectName,
      DISCLAUDE_WORKBUDDY_SOCKET: socketPath,
      DISCLAUDE_WORKBUDDY_CWD: projectConfig.cwd,
      DISCLAUDE_WORKBUDDY_CHAT_ID: projectConfig.chatId,
    };

    if (projectConfig.tools?.length) {
      env.DISCLAUDE_WORKBUDDY_TOOLS = projectConfig.tools.join(',');
    }

    // Spawn a long-lived node process that acts as the WorkBuddy agent.
    // For Phase 1, this is a minimal runner that sets up the IPC socket and
    // waits for commands. The full agent implementation comes in a later phase.
    const child = spawn('node', ['-e', this.getWorkBuddyRunnerSource()], {
      cwd: projectConfig.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const entry = this.processes.get(projectName);
    if (!entry) {
      throw new Error(`WorkBuddy process entry missing for "${projectName}"`);
    }
    entry.pid = child.pid;

    child.stdout?.on('data', (data: Buffer) => {
      logger.debug({ projectName, stdout: data.toString().trim() }, 'WorkBuddy stdout');
    });

    child.stderr?.on('data', (data: Buffer) => {
      logger.debug({ projectName, stderr: data.toString().trim() }, 'WorkBuddy stderr');
    });

    child.on('exit', (code, signal) => {
      const wasRunning = entry.status === 'running' || entry.status === 'starting';
      entry.status = code === 0 ? 'stopped' : 'error';
      if (code !== 0 && wasRunning) {
        entry.errorMessage = `Process exited with code ${code}, signal ${signal}`;
        logger.error({ projectName, code, signal }, 'WorkBuddy process exited unexpectedly');
      }
      this.childProcesses.delete(projectName);
    });

    child.on('error', (err) => {
      entry.status = 'error';
      entry.errorMessage = err.message;
      logger.error({ projectName, err: err.message }, 'WorkBuddy process error');
    });

    this.childProcesses.set(projectName, child);

    // Give the process a moment to start up
    await new Promise((resolve) => setTimeout(resolve, STARTUP_GRACE_PERIOD_MS));

    if (entry.status === 'error') {
      throw new Error(entry.errorMessage ?? 'WorkBuddy process failed to start');
    }
  }

  /**
   * Generate the minimal WorkBuddy runner source for Phase 1.
   *
   * This is a placeholder that keeps the process alive and listens for
   * signals. The actual agent (Claude Code SDK integration) will replace
   * this in a follow-up phase.
   */
  private getWorkBuddyRunnerSource(): string {
    return `
const { createServer } = require('net');
const fs = require('fs');
const path = require('path');

const socketPath = process.env.DISCLAUDE_WORKBUDDY_SOCKET;
const projectName = process.env.DISCLAUDE_WORKBUDDY_PROJECT;

if (!socketPath) {
  process.stderr.write('DISCLAUDE_WORKBUDDY_SOCKET not set\\n');
  process.exit(1);
}

// Clean up stale socket
if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

const server = createServer((conn) => {
  let buffer = '';
  conn.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        // Echo back as placeholder response
        const resp = JSON.stringify({ id: msg.id, success: false, error: 'WorkBuddy agent not yet implemented (Phase 1 placeholder)' });
        conn.write(resp + '\\n');
      } catch {}
    }
  });
});

server.listen(socketPath, () => {
  process.stderr.write('[WorkBuddy] Listening on ' + socketPath + '\\n');
});

// Graceful shutdown
const shutdown = () => {
  server.close(() => {
    try { fs.unlinkSync(socketPath); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;
  }

  /**
   * Check if a child process is still alive.
   */
  private isProcessAlive(projectName: string): boolean {
    const child = this.childProcesses.get(projectName);
    if (!child) {return false;}
    try {
      child.kill(0); // Signal 0 = existence check
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate a Unix socket path for a WorkBuddy project.
   */
  private generateSocketPath(projectName: string): string {
    return join(tmpdir(), `workbuddy-${projectName}-${process.pid}-${Date.now()}.sock`);
  }

  /**
   * Clean up a Unix socket file.
   */
  private cleanupSocket(socketPath: string): void {
    try {
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Start periodic health checks for all running processes.
   */
  private startHealthChecks(): void {
    if (this.healthCheckTimer) {return;}

    const consecutiveFailures = new Map<string, number>();

    this.healthCheckTimer = setInterval(() => {
      for (const [projectName, entry] of this.processes) {
        if (entry.status !== 'running') {continue;}

        const alive = this.isProcessAlive(projectName);
        if (!alive) {
          const failures = (consecutiveFailures.get(projectName) ?? 0) + 1;
          consecutiveFailures.set(projectName, failures);

          if (failures >= MAX_HEALTH_FAILURES) {
            entry.status = 'error';
            entry.errorMessage = `Health check failed ${failures} consecutive times`;
            logger.error({ projectName, failures }, 'WorkBuddy process marked as error after repeated health check failures');
            consecutiveFailures.delete(projectName);
          }
        } else {
          consecutiveFailures.delete(projectName);
          entry.lastHealthCheck = new Date().toISOString();
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Stop periodic health checks.
   */
  private stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }
}
