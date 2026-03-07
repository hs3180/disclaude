/**
 * IPC module for cross-process communication.
 *
 * This module provides Unix Socket based IPC for sharing state between
 * the MCP process and the main bot process.
 *
 * Issue #1035: Extended to support Feishu API request routing.
 *
 * @module ipc
 */

export * from './protocol.js';
export * from './unix-socket-server.js';
export * from './unix-socket-client.js';
// Issue #1035: Feishu API IPC routing
export * from './feishu-api-handler.js';
export * from './feishu-api-server.js';
export * from './feishu-api-client.js';
