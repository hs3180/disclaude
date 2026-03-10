/**
 * IPC module for cross-process communication.
 *
 * This module provides Unix Socket based IPC for sharing state between
 * the MCP process and the main bot process.
 *
 * @module ipc
 */

// Re-export types from @disclaude/core
export type {
  IpcRequestType,
  IpcRequestPayloads,
  IpcResponsePayloads,
  IpcRequest,
  IpcResponse,
  IpcConfig,
} from '@disclaude/core';

export { DEFAULT_IPC_CONFIG } from '@disclaude/core';

// Server and client implementations
export * from './unix-socket-server.js';
export * from './unix-socket-client.js';
