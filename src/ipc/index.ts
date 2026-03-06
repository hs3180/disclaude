/**
 * IPC module for cross-process communication.
 *
 * This module provides Unix Socket based IPC for sharing state between
 * the MCP process and the main bot process.
 *
 * @module ipc
 */

export * from './protocol.js';
export * from './unix-socket-server.js';
export * from './unix-socket-client.js';
