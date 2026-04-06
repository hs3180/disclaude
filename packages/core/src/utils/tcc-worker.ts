/**
 * TCC Worker Daemon — Standalone process for executing TCC-protected operations.
 *
 * Issue #1957: macOS TCC (Transparency, Consent, and Control) silently denies
 * access to protected resources (microphone, camera, etc.) when running under
 * PM2, because TCC walks the entire process tree and blocks if any ancestor
 * lacks the required permission.
 *
 * This worker process is designed to run OUTSIDE the PM2 process tree. It:
 * - Listens on a Unix socket for command execution requests
 * - Executes commands in its own process context (free from PM2's TCC chain)
 * - Returns results via structured IPC protocol
 * - Auto-shuts down after a configurable idle timeout
 *
 * ## Launch Methods (to break PM2 process tree)
 *
 * 1. **`open -a Terminal.app launcher.command`** (recommended on macOS):
 *    Uses macOS launch services, creating a process whose ancestry goes
 *    through Terminal.app → launchd, NOT through PM2.
 *
 * 2. **`launchctl load plist`** (most robust on macOS):
 *    Launches via launchd directly, completely independent of PM2.
 *
 * 3. **`detached: true` spawn** (cross-platform fallback):
 *    Creates a new session via setsid(). May not fully break TCC chain
 *    on macOS but works on other platforms.
 *
 * @module core/utils/tcc-worker
 */

import { unlinkSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { createServer, type Server, type Socket } from 'net';
import { spawn, type ChildProcess } from 'child_process';

// ============================================================================
// Types
// ============================================================================

/**
 * TCC Worker request types.
 */
export type TccWorkerRequestType = 'exec' | 'spawn' | 'ping' | 'shutdown';

/**
 * TCC Worker exec request payload.
 */
export interface TccWorkerExecPayload {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * TCC Worker spawn request payload.
 */
export interface TccWorkerSpawnPayload {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * TCC Worker request.
 */
export interface TccWorkerRequest {
  id: string;
  type: TccWorkerRequestType;
  payload?: TccWorkerExecPayload | TccWorkerSpawnPayload;
}

/**
 * TCC Worker response payload for exec operations.
 */
export interface TccWorkerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * TCC Worker response payload for spawn operations.
 */
export interface TccWorkerSpawnResult {
  pid: number;
  /** Path to a named pipe or temp file for stdout streaming */
  stdoutPipe?: string;
  /** Path to a named pipe or temp file for stderr streaming */
  stderrPipe?: string;
}

/**
 * TCC Worker response.
 */
export interface TccWorkerResponse {
  id: string;
  success: boolean;
  payload?: TccWorkerExecResult | TccWorkerSpawnResult | { pong: true };
  error?: string;
}

/**
 * TCC Worker configuration.
 */
export interface TccWorkerConfig {
  /** Unix socket path for IPC communication */
  socketPath: string;
  /** Idle timeout in milliseconds before auto-shutdown (default: 300000 = 5min) */
  idleTimeout: number;
  /** Maximum concurrent command executions */
  maxConcurrent: number;
}

/**
 * Default TCC Worker configuration.
 */
export const DEFAULT_TCC_WORKER_CONFIG: TccWorkerConfig = {
  socketPath: join(tmpdir(), 'disclaude-tcc-worker.sock'),
  idleTimeout: 300_000, // 5 minutes
  maxConcurrent: 5,
};

/**
 * Generate a unique socket path for the TCC worker.
 */
export function generateTccWorkerSocketPath(): string {
  return join(
    tmpdir(),
    `disclaude-tcc-worker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`
  );
}

// ============================================================================
// TCC Worker Daemon
// ============================================================================

/**
 * Active process tracker for spawned children.
 */
interface TrackedProcess {
  child: ChildProcess;
  resolve: (result: TccWorkerExecResult) => void;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Standalone TCC Worker Daemon.
 *
 * Runs as an independent process outside the PM2 tree, listening on a Unix
 * socket for TCC-protected command execution requests.
 */
export class TccWorkerDaemon {
  private server: Server | null = null;
  private config: TccWorkerConfig;
  private activeConnections: Set<Socket> = new Set();
  private activeProcesses: Map<string, TrackedProcess> = new Map();
  private isShuttingDown = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<TccWorkerConfig>) {
    this.config = { ...DEFAULT_TCC_WORKER_CONFIG, ...config };
  }

  /**
   * Start the TCC Worker daemon.
   */
  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    // Ensure socket directory exists
    const socketDir = dirname(this.config.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true });
    }

    // Clean up stale socket
    if (existsSync(this.config.socketPath)) {
      try {
        unlinkSync(this.config.socketPath);
      } catch {
        // Ignore — socket might be in use
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (error) => {
        if (!this.server?.listening) {
          reject(error);
        }
      });

      this.server.listen(this.config.socketPath, () => {
        this.resetIdleTimer();
        this.registerSignalHandlers();
        resolve();
      });
    });
  }

  /**
   * Stop the TCC Worker daemon gracefully.
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;
    this.clearIdleTimer();

    // Kill all active child processes
    for (const [id, tracked] of this.activeProcesses) {
      clearTimeout(tracked.timer);
      try {
        tracked.child.kill('SIGTERM');
      } catch {
        // Process might already be dead
      }
      tracked.resolve({
        exitCode: -1,
        stdout: '',
        stderr: 'Worker shutting down',
      });
      this.activeProcesses.delete(id);
    }

    // Close all connections
    for (const socket of this.activeConnections) {
      try {
        socket.destroy();
      } catch {
        // Ignore
      }
    }
    this.activeConnections.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        // Clean up socket file
        if (existsSync(this.config.socketPath)) {
          try {
            unlinkSync(this.config.socketPath);
          } catch {
            // Ignore cleanup errors
          }
        }
        this.server = null;
        this.isShuttingDown = false;
        resolve();
      });
    });
  }

  /**
   * Check if the daemon is running.
   */
  isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  /**
   * Get the socket path.
   */
  getSocketPath(): string {
    return this.config.socketPath;
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  /**
   * Reset the idle shutdown timer.
   */
  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.stop();
    }, this.config.idleTimeout);
    // Allow process to exit even with active timer
    if (this.idleTimer && 'unref' in this.idleTimer) {
      this.idleTimer.unref();
    }
  }

  /**
   * Clear the idle shutdown timer.
   */
  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Register signal handlers for graceful shutdown.
   */
  private registerSignalHandlers(): void {
    const shutdown = () => {
      void this.stop().then(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  /**
   * Handle a new IPC connection.
   */
  private handleConnection(socket: Socket): void {
    if (this.isShuttingDown) {
      socket.destroy();
      return;
    }

    this.activeConnections.add(socket);
    let buffer = '';

    socket.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) {
          void this.handleMessage(socket, line);
        }
      }
    });

    socket.on('close', () => {
      this.activeConnections.delete(socket);
    });

    socket.on('error', () => {
      this.activeConnections.delete(socket);
    });
  }

  /**
   * Handle an incoming IPC message.
   */
  private async handleMessage(socket: Socket, data: string): Promise<void> {
    let request: TccWorkerRequest;
    try {
      request = JSON.parse(data);
    } catch {
      this.sendResponse(socket, {
        id: '0',
        success: false,
        error: 'Invalid JSON',
      });
      return;
    }

    this.resetIdleTimer();

    switch (request.type) {
      case 'ping':
        this.sendResponse(socket, {
          id: request.id,
          success: true,
          payload: { pong: true },
        });
        break;

      case 'exec':
        await this.handleExec(socket, request);
        break;

      case 'spawn':
        await this.handleSpawn(socket, request);
        break;

      case 'shutdown':
        this.sendResponse(socket, {
          id: request.id,
          success: true,
          payload: { pong: true },
        });
        void this.stop();
        break;

      default:
        this.sendResponse(socket, {
          id: request.id,
          success: false,
          error: `Unknown request type: ${(request as { type: string }).type}`,
        });
    }
  }

  /**
   * Handle an exec request — execute a command and capture output.
   */
  private handleExec(socket: Socket, request: TccWorkerRequest): void {
    const payload = request.payload as TccWorkerExecPayload | undefined;
    if (!payload?.command) {
      this.sendResponse(socket, {
        id: request.id,
        success: false,
        error: 'Missing command in exec payload',
      });
      return;
    }

    if (this.activeProcesses.size >= this.config.maxConcurrent) {
      this.sendResponse(socket, {
        id: request.id,
        success: false,
        error: `Max concurrent processes reached (${this.config.maxConcurrent})`,
      });
      return;
    }

    const timeout = payload.timeout ?? 30_000;
    const trackedId = request.id;

    const child = spawn(payload.command, payload.args ?? [], {
      cwd: payload.cwd,
      env: payload.env ? { ...process.env, ...payload.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead
      }
    }, timeout);

    if ('unref' in timer) {
      timer.unref();
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      this.activeProcesses.delete(trackedId);

      const result: TccWorkerExecResult = {
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
      };

      this.sendResponse(socket, {
        id: request.id,
        success: code === 0,
        payload: result,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      this.activeProcesses.delete(trackedId);

      this.sendResponse(socket, {
        id: request.id,
        success: false,
        error: `Spawn error: ${error.message}`,
      });
    });

    // Close stdin
    child.stdin?.end();

    this.activeProcesses.set(trackedId, {
      child,
      resolve: () => {}, // Not used for async response pattern
      stdoutChunks,
      stderrChunks,
      timer,
    });
  }

  /**
   * Handle a spawn request — spawn a long-running process.
   */
  private handleSpawn(socket: Socket, request: TccWorkerRequest): void {
    const payload = request.payload as TccWorkerSpawnPayload | undefined;
    if (!payload?.command) {
      this.sendResponse(socket, {
        id: request.id,
        success: false,
        error: 'Missing command in spawn payload',
      });
      return;
    }

    if (this.activeProcesses.size >= this.config.maxConcurrent) {
      this.sendResponse(socket, {
        id: request.id,
        success: false,
        error: `Max concurrent processes reached (${this.config.maxConcurrent})`,
      });
      return;
    }

    const child = spawn(payload.command, payload.args ?? [], {
      cwd: payload.cwd,
      env: payload.env ? { ...process.env, ...payload.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    // Close stdin since caller communicates via IPC
    child.stdin?.end();

    this.sendResponse(socket, {
      id: request.id,
      success: true,
      payload: {
        pid: child.pid ?? -1,
      },
    });

    // Track the spawned process for cleanup
    const trackedId = `spawn-${child.pid}`;
    this.activeProcesses.set(trackedId, {
      child,
      resolve: () => {},
      stdoutChunks: [],
      stderrChunks: [],
      timer: setTimeout(() => {}, 0),
    });

    child.on('close', () => {
      this.activeProcesses.delete(trackedId);
    });

    child.on('error', () => {
      this.activeProcesses.delete(trackedId);
    });
  }

  /**
   * Send a JSON response over the socket.
   */
  private sendResponse(socket: Socket, response: TccWorkerResponse): void {
    try {
      socket.write(`${JSON.stringify(response)}\n`);
    } catch {
      // Socket might be closed
    }
  }
}

// ============================================================================
// Worker Launcher
// ============================================================================

/**
 * Result of launching the TCC worker.
 */
export interface TccWorkerLaunchResult {
  success: boolean;
  socketPath: string;
  method: 'open' | 'detached' | 'already_running';
  error?: string;
}

/**
 * Launch modes for the TCC worker.
 */
export type TccWorkerLaunchMode = 'auto' | 'open' | 'detached';

/**
 * Launch the TCC worker daemon as a standalone process outside PM2's tree.
 *
 * @param options - Launch configuration
 * @returns Launch result with socket path and method used
 */
export function launchTccWorker(options?: {
  socketPath?: string;
  mode?: TccWorkerLaunchMode;
  /** Path to the worker script (for spawn) */
  workerScriptPath?: string;
  /** Extra environment variables for the worker */
  env?: Record<string, string>;
}): TccWorkerLaunchResult {
  const socketPath = options?.socketPath ?? DEFAULT_TCC_WORKER_CONFIG.socketPath;
  const mode = options?.mode ?? 'auto';

  // Check if worker is already running
  if (existsSync(socketPath)) {
    return {
      success: true,
      socketPath,
      method: 'already_running',
    };
  }

  const workerScriptPath = options?.workerScriptPath ?? __filename;
  const env = options?.env ?? {};

  if (mode === 'open' || (mode === 'auto' && process.platform === 'darwin')) {
    return launchViaOpen(socketPath, workerScriptPath, env);
  }

  return launchDetached(socketPath, workerScriptPath, env);
}

/**
 * Launch the worker via macOS `open` command.
 *
 * This breaks the PM2 process tree because `open` goes through
 * macOS launch services → Terminal.app → worker, bypassing PM2.
 */
function launchViaOpen(
  socketPath: string,
  workerScriptPath: string,
  extraEnv: Record<string, string>
): TccWorkerLaunchResult {
  try {
    // Create a launcher shell script
    const launcherPath = join(tmpdir(), `disclaude-tcc-launcher-${Date.now()}.command`);
    const envVars = Object.entries(extraEnv)
      .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
      .join('\n');

    const launcherScript = `#!/bin/bash
${envVars}
nohup node "${workerScriptPath}" --socket-path="${socketPath}" > /dev/null 2>&1 &
echo $!
`;

    writeFileSync(launcherPath, launcherScript, { mode: 0o755 });

    // Use `open` to launch via Terminal.app (breaks PM2 chain)
    const openResult = spawn('open', [launcherPath], {
      detached: true,
      stdio: 'ignore',
    });
    openResult.unref();

    return {
      success: true,
      socketPath,
      method: 'open',
    };
  } catch (error) {
    return {
      success: false,
      socketPath,
      method: 'open',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Launch the worker as a detached process (cross-platform fallback).
 *
 * Uses `detached: true` + `unref()` to create a new process session.
 * Note: On macOS, this may not fully break the TCC chain since PPID
 * still points to the parent. Use `open` mode for full TCC bypass.
 */
function launchDetached(
  socketPath: string,
  workerScriptPath: string,
  extraEnv: Record<string, string>
): TccWorkerLaunchResult {
  try {
    const child = spawn(process.execPath, [
      workerScriptPath,
      '--socket-path', socketPath,
    ], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...extraEnv, __DISCLAUDE_TCC_WORKER: '1' },
    });
    child.unref();

    return {
      success: true,
      socketPath,
      method: 'detached',
    };
  } catch (error) {
    return {
      success: false,
      socketPath,
      method: 'detached',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// CLI Entry Point (when run directly)
// ============================================================================

/**
 * Parse command-line arguments for the worker daemon.
 */
function parseArgs(args: string[]): { socketPath: string } {
  let socketPath = DEFAULT_TCC_WORKER_CONFIG.socketPath;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket-path' && args[i + 1]) {
      socketPath = args[i + 1];
      i++;
    }
  }

  return { socketPath };
}

/**
 * Main entry point when the worker is run as a standalone process.
 *
 * Usage: node tcc-worker.js --socket-path /path/to/worker.sock
 */
export async function runWorkerDaemon(args: string[]): Promise<void> {
  const { socketPath } = parseArgs(args);
  const daemon = new TccWorkerDaemon({ socketPath });

  await daemon.start();

  // Keep the process alive
  process.on('SIGTERM', () => {
    void daemon.stop().then(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    void daemon.stop().then(() => process.exit(0));
  });

  // Prevent Node.js from exiting while server is listening
  process.stdin.resume();
}

// Auto-run if executed directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
if (typeof require !== 'undefined' && process.argv[1] && import.meta.url) {
  // This module is imported as a library, not run directly.
  // Use runWorkerDaemon() explicitly from a CLI entry point.
}
