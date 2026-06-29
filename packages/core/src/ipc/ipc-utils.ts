/**
 * IPC utility functions.
 *
 * Issue #4129: Extracted from unix-socket-client.ts to separate
 * connection/protocol concerns from utility functions.
 *
 * @module ipc/ipc-utils
 */

import { existsSync, readFileSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import {
  DEFAULT_IPC_CONFIG,
  IPC_SOCKET_PATH_FILE,
} from './protocol.js';
import { UnixSocketIpcClient } from './unix-socket-client.js';

const logger = createLogger('IpcUtils');

/**
 * Check if a process with the given PID is still running.
 * Used to detect stale socket path files (Issue #3808).
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Options for getIpcSocketPath().
 *
 * @param override - Highest-priority override (e.g., CLI --socket argument).
 *   Supports both Unix socket paths and HTTP URLs (for future transport migration).
 */
export interface GetIpcSocketPathOptions {
  /** Highest-priority override for the socket path. */
  override?: string;
}

/**
 * Get IPC socket path with fallback chain.
 *
 * Priority:
 * 1. override parameter (e.g., --socket CLI argument)
 * 2. DISCLAUDE_WORKER_IPC_SOCKET env var (set by Worker Node for MCP Server)
 * 3. DISCLAUDE_IPC_SOCKET_PATH env var (manual override)
 * 4. IPC_SOCKET_PATH_FILE (written by Primary Node, Issue #3808)
 * 5. DEFAULT_IPC_CONFIG.socketPath (Primary Node default)
 */
export function getIpcSocketPath(options?: GetIpcSocketPathOptions): string {
  // CLI argument override takes highest priority
  if (options?.override) {return options.override;}

  // Try env vars first
  const envPath = process.env.DISCLAUDE_WORKER_IPC_SOCKET ||
    process.env.DISCLAUDE_IPC_SOCKET_PATH;
  if (envPath) {return envPath;}

  // Issue #3808: Read from well-known file written by Primary Node.
  // File format: "socketPath\nPID" — PID is checked for staleness.
  try {
    if (existsSync(IPC_SOCKET_PATH_FILE)) {
      const content = readFileSync(IPC_SOCKET_PATH_FILE, 'utf-8').trim();
      if (content) {
        const lines = content.split('\n');
        const socketPath = lines[0]?.trim();
        if (socketPath) {
          // Check PID staleness if present
          const pid = lines[1] ? parseInt(lines[1].trim(), 10) : NaN;
          if (!isNaN(pid) && !isProcessRunning(pid)) {
            logger.warn({ pid }, 'IPC socket path file is stale (PID not running)');
            // Fall through to default
          } else {
            return socketPath;
          }
        }
      }
    }
  } catch {
    // Ignore file read errors — fall through to default
  }

  return DEFAULT_IPC_CONFIG.socketPath;
}

// Singleton instance
let ipcClientInstance: UnixSocketIpcClient | null = null;

/**
 * Get the global IPC client instance.
 *
 * Issue #1042: Uses socket path from environment variable if set.
 * Priority: DISCLAUDE_WORKER_IPC_SOCKET > DISCLAUDE_IPC_SOCKET_PATH > default
 */
export function getIpcClient(): UnixSocketIpcClient {
  if (!ipcClientInstance) {
    const socketPath = getIpcSocketPath();
    ipcClientInstance = new UnixSocketIpcClient({ socketPath });
  }
  return ipcClientInstance;
}

/**
 * Reset the global IPC client (for testing).
 */
export function resetIpcClient(): void {
  if (ipcClientInstance) {
    ipcClientInstance.disconnect().catch(() => {});
  }
  ipcClientInstance = null;
}
