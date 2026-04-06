/**
 * TCC-Safe Spawn — Client utility for executing commands through the TCC Worker.
 *
 * Issue #1957: Provides `tccSafeExec()` and `tccSafeSpawn()` APIs that transparently
 * route commands through a standalone TCC Worker daemon when running under PM2 on
 * macOS, bypassing the TCC process tree restrictions.
 *
 * On non-PM2 or non-macOS environments, commands are executed directly with no
 * overhead — the worker is not launched.
 *
 * @example
 * ```typescript
 * import { tccSafeExec, tccSafeSpawn, isUnderPM2 } from '@disclaude/core';
 *
 * // Execute a command and capture output
 * const { stdout } = await tccSafeExec('python3', ['record.py'], {
 *   tccResource: 'microphone',
 * });
 *
 * // Spawn a long-running process
 * const child = await tccSafeSpawn('ffmpeg', ['-i', ...args], {
 *   tccResource: 'microphone',
 * });
 * ```
 *
 * @module core/utils/tcc-safe-spawn
 */

import { existsSync } from 'fs';
import { createConnection, type Socket } from 'net';
import { platform } from 'os';
import { execFile, type ChildProcess } from 'child_process';
import { createLogger } from './logger.js';
import {
  launchTccWorker,
  generateTccWorkerSocketPath,
  type TccWorkerExecResult,
  type TccWorkerRequest,
  type TccWorkerResponse,
  type TccWorkerLaunchMode,
} from './tcc-worker.js';

const logger = createLogger('TccSafeSpawn');

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Check if the current platform is macOS.
 */
export function isMacOS(): boolean {
  return platform() === 'darwin';
}

/**
 * Check if the current process is running under PM2.
 *
 * Walks the process tree via /proc (Linux) or `ps` (macOS) to detect
 * a PM2 God Daemon ancestor.
 */
export function isUnderPM2(): boolean {
  // Check for PM2-specific environment variables first (fast path)
  if (process.env.PM2_HOME || process.env.pm_id !== undefined) {
    return true;
  }

  // Check for PM2 in process title
  if (process.title && process.title.includes('PM2')) {
    return true;
  }

  // Walk the process tree on macOS via ps command
  // (reading /proc is not available on macOS)
  if (isMacOS()) {
    try {
      const { execFileSync } = require('child_process') as typeof import('child_process');
      const output = execFileSync('ps', ['-o', 'ppid=', '-p', String(process.pid)], {
        encoding: 'utf-8',
        timeout: 2000,
      }).trim();

      let currentPid = parseInt(output, 10);
      const maxDepth = 20;

      for (let depth = 0; depth < maxDepth && currentPid > 1; depth++) {
        try {
          const ppidOutput = execFileSync('ps', ['-o', 'ppid=', '-p', String(currentPid)], {
            encoding: 'utf-8',
            timeout: 2000,
          }).trim();

          const ppid = parseInt(ppidOutput, 10);
          if (ppid <= 1) break;

          // Check if this process is PM2 God Daemon
          const commOutput = execFileSync('ps', ['-o', 'comm=', '-p', String(currentPid)], {
            encoding: 'utf-8',
            timeout: 2000,
          }).trim();

          if (commOutput.includes('PM2') || commOutput.includes('pm2')) {
            return true;
          }

          currentPid = ppid;
        } catch {
          break;
        }
      }
    } catch {
      // ps command failed — assume not under PM2
    }
  }

  return false;
}

/**
 * Check if TCC-safe execution is needed (macOS + PM2).
 */
export function needsTccWorker(): boolean {
  return isMacOS() && isUnderPM2();
}

// ============================================================================
// Types
// ============================================================================

/**
 * Options for TCC-safe execution.
 */
export interface TccSafeExecOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables to merge with process.env */
  env?: Record<string, string>;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /**
   * The TCC-protected resource being accessed.
   * Used for logging and future TCC permission hints.
   * Example: 'microphone', 'camera', 'screen'
   */
  tccResource?: string;
  /** Socket path for the TCC worker (auto-generated if not provided) */
  workerSocketPath?: string;
  /** Worker launch mode */
  workerLaunchMode?: TccWorkerLaunchMode;
  /** Maximum time to wait for worker to become ready (default: 10000) */
  workerReadyTimeout?: number;
}

/**
 * Result of tccSafeExec.
 */
export interface TccSafeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ============================================================================
// TCC Worker Client
// ============================================================================

/**
 * Client for communicating with the TCC Worker daemon via IPC.
 */
export class TccWorkerClient {
  private socketPath: string;
  private socket: Socket | null = null;
  private connected = false;
  private connecting = false;
  private buffer = '';
  private pendingRequests: Map<string, {
    resolve: (response: TccWorkerResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  private requestId = 0;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Connect to the TCC Worker daemon.
   */
  async connect(timeout = 5000): Promise<void> {
    if (this.connected) return;
    if (this.connecting) {
      // Wait for existing connection attempt
      return new Promise((resolve, reject) => {
        const check = () => {
          if (this.connected) resolve();
          else if (!this.connecting) reject(new Error('Connection failed'));
          else setTimeout(check, 50);
        };
        check();
      });
    }

    this.connecting = true;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.destroy();
        this.connecting = false;
        reject(new Error('TCC Worker connection timeout'));
      }, timeout);

      this.socket = createConnection(this.socketPath);

      this.socket.on('connect', () => {
        clearTimeout(timer);
        this.connected = true;
        this.connecting = false;
        resolve();
      });

      this.socket.on('error', (error) => {
        clearTimeout(timer);
        this.connecting = false;
        reject(error);
      });

      this.socket.on('data', (data: Buffer) => {
        this.handleData(data.toString());
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.connecting = false;
        this.socket = null;
        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error('TCC Worker connection closed'));
        }
        this.pendingRequests.clear();
      });
    });
  }

  /**
   * Disconnect from the TCC Worker.
   */
  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.connecting = false;
    this.buffer = '';
    this.pendingRequests.clear();
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a request to the TCC Worker and wait for the response.
   */
  async request<T extends TccWorkerRequest['type']>(
    type: T,
    payload?: TccWorkerRequest['payload']
  ): Promise<TccWorkerResponse> {
    if (!this.connected) {
      await this.connect();
    }

    const id = `${++this.requestId}`;
    const request: TccWorkerRequest = { id, type, payload } as TccWorkerRequest;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`TCC Worker request timeout: ${type}`));
      }, 60_000); // Worker has its own timeout, this is a safety net

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer,
      });

      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.socket!.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Ping the TCC Worker.
   */
  async ping(): Promise<boolean> {
    try {
      const response = await this.request('ping');
      return response.success;
    } catch {
      return false;
    }
  }

  /**
   * Request the worker to shut down.
   */
  async shutdown(): Promise<void> {
    try {
      await this.request('shutdown');
    } finally {
      await this.disconnect();
    }
  }

  /**
   * Handle incoming data from the socket.
   */
  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response: TccWorkerResponse = JSON.parse(line);
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(response.id);
            pending.resolve(response);
          }
        } catch {
          // Ignore malformed responses
        }
      }
    }
  }
}

// ============================================================================
// Worker Lifecycle Management
// ============================================================================

/** Singleton client instance */
let workerClient: TccWorkerClient | null = null;
/** The socket path used for the current worker */
let currentSocketPath: string | null = null;

/**
 * Ensure the TCC Worker is running and return a connected client.
 *
 * If the worker is not already running, launches it using the appropriate
 * method for the current platform.
 */
async function ensureWorker(options?: {
  socketPath?: string;
  launchMode?: TccWorkerLaunchMode;
  readyTimeout?: number;
}): Promise<TccWorkerClient> {
  const socketPath = options?.socketPath ?? currentSocketPath ?? generateTccWorkerSocketPath();
  const readyTimeout = options?.readyTimeout ?? 10_000;

  // If we have a connected client, reuse it
  if (workerClient?.isConnected()) {
    return workerClient;
  }

  // Check if worker is already running
  if (existsSync(socketPath)) {
    const client = new TccWorkerClient(socketPath);
    try {
      await client.connect(readyTimeout);
      // Verify with ping
      const alive = await client.ping();
      if (alive) {
        workerClient = client;
        currentSocketPath = socketPath;
        return workerClient;
      }
      await client.disconnect();
    } catch {
      // Worker socket exists but not responding — stale, launch new one
    }
  }

  // Launch a new worker
  const launchResult = launchTccWorker({
    socketPath,
    mode: options?.launchMode ?? 'auto',
  });

  if (!launchResult.success) {
    throw new Error(
      `Failed to launch TCC Worker: ${launchResult.error ?? 'unknown error'}`
    );
  }

  // Wait for the worker to become ready
  const startTime = Date.now();
  while (Date.now() - startTime < readyTimeout) {
    if (existsSync(socketPath)) {
      const client = new TccWorkerClient(socketPath);
      try {
        await client.connect(2000);
        const alive = await client.ping();
        if (alive) {
          workerClient = client;
          currentSocketPath = socketPath;
          return workerClient;
        }
        await client.disconnect();
      } catch {
        // Not ready yet
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(
    `TCC Worker did not become ready within ${readyTimeout}ms (socket: ${socketPath})`
  );
}

/**
 * Reset the worker client (for testing or forced restart).
 */
export function resetTccWorkerClient(): void {
  if (workerClient) {
    workerClient.disconnect().catch(() => {});
    workerClient = null;
  }
  currentSocketPath = null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Execute a command through the TCC Worker (or directly if not under PM2).
 *
 * When running under PM2 on macOS, the command is routed through the
 * standalone TCC Worker daemon which runs outside the PM2 process tree,
 * bypassing TCC restrictions.
 *
 * On other platforms or when not under PM2, executes directly via
 * `child_process.execFile` with no overhead.
 *
 * @param command - The command to execute (e.g., 'python3', 'ffmpeg')
 * @param args - Command arguments
 * @param options - Execution options
 * @returns Execution result with exitCode, stdout, stderr
 *
 * @example
 * ```typescript
 * // Record audio via TCC worker (bypasses PM2 TCC restriction)
 * const result = await tccSafeExec('python3', ['record.py', '--duration', '5'], {
 *   tccResource: 'microphone',
 *   timeout: 30000,
 * });
 *
 * if (result.exitCode === 0) {
 *   console.log('Audio recorded:', result.stdout);
 * }
 * ```
 */
export async function tccSafeExec(
  command: string,
  args: string[],
  options?: TccSafeExecOptions
): Promise<TccSafeExecResult> {
  // Fast path: if not under PM2, execute directly
  if (!needsTccWorker()) {
    return directExec(command, args, options);
  }

  // Slow path: route through TCC Worker
  logger.debug(
    { command, args: args.length, tccResource: options?.tccResource },
    'Routing command through TCC Worker (PM2 detected on macOS)'
  );

  try {
    const client = await ensureWorker({
      socketPath: options?.workerSocketPath,
      launchMode: options?.workerLaunchMode,
      readyTimeout: options?.workerReadyTimeout,
    });

    const response = await client.request('exec', {
      command,
      args,
      env: options?.env,
      cwd: options?.cwd,
      timeout: options?.timeout,
    });

    if (!response.success || !response.payload) {
      const result: TccSafeExecResult = {
        exitCode: -1,
        stdout: '',
        stderr: response.error ?? 'Unknown TCC Worker error',
      };

      // Log the failure for debugging
      logger.warn(
        { command, error: response.error },
        'TCC Worker exec failed'
      );

      return result;
    }

    const payload = response.payload as TccWorkerExecResult;
    return {
      exitCode: payload.exitCode,
      stdout: payload.stdout,
      stderr: payload.stderr,
    };
  } catch (error) {
    logger.error(
      { err: error, command },
      'TCC Worker unavailable, falling back to direct execution'
    );

    // Fallback to direct execution if worker is unavailable
    return directExec(command, args, options);
  }
}

/**
 * Spawn a long-running process through the TCC Worker.
 *
 * When running under PM2 on macOS, the process is spawned by the TCC Worker
 * which runs outside the PM2 process tree.
 *
 * @param command - The command to spawn
 * @param args - Command arguments
 * @param options - Spawn options
 * @returns The spawned child process (or proxy info)
 */
export async function tccSafeSpawn(
  command: string,
  args: string[],
  options?: TccSafeExecOptions
): Promise<{ pid: number }> {
  // Fast path: if not under PM2, spawn directly
  if (!needsTccWorker()) {
    const child = spawnDirect(command, args, options);
    return { pid: child.pid ?? -1 };
  }

  // Slow path: route through TCC Worker
  logger.debug(
    { command, args: args.length, tccResource: options?.tccResource },
    'Spawning process through TCC Worker (PM2 detected on macOS)'
  );

  const client = await ensureWorker({
    socketPath: options?.workerSocketPath,
    launchMode: options?.workerLaunchMode,
    readyTimeout: options?.workerReadyTimeout,
  });

  const response = await client.request('spawn', {
    command,
    args,
    env: options?.env,
    cwd: options?.cwd,
  });

  if (!response.success || !response.payload) {
    throw new Error(
      `TCC Worker spawn failed: ${response.error ?? 'Unknown error'}`
    );
  }

  const payload = response.payload as { pid: number };
  return { pid: payload.pid };
}

/**
 * Request the TCC Worker to shut down.
 */
export async function shutdownTccWorker(): Promise<void> {
  if (workerClient?.isConnected()) {
    try {
      await workerClient.shutdown();
    } finally {
      resetTccWorkerClient();
    }
  }
}

// ============================================================================
// Direct Execution (fallback / non-PM2 path)
// ============================================================================

/**
 * Execute a command directly via execFile (no TCC Worker).
 */
function directExec(
  command: string,
  args: string[],
  options?: TccSafeExecOptions
): Promise<TccSafeExecResult> {
  return new Promise((resolve) => {
    void execFile(command, args, {
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      timeout: options?.timeout ?? 30_000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error?.code !== undefined
          ? (typeof error.code === 'number' ? error.code : -1)
          : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
  });
}

/**
 * Spawn a process directly (no TCC Worker).
 */
function spawnDirect(
  command: string,
  args: string[],
  options?: TccSafeExecOptions
): ChildProcess {
  return execFile(command, args, {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : process.env,
    timeout: options?.timeout,
  });
}
