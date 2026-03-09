/**
 * @disclaude/core
 *
 * Shared core utilities, types, and interfaces for disclaude.
 *
 * This package contains:
 * - Type definitions (platform, websocket, file)
 * - Constants (deduplication, dialogue, api config)
 * - Utility functions (logger, error-handler, retry)
 * - IPC Protocol (shared between Primary Node and MCP Server)
 */

// Types
export * from './types/index.js';

// Constants
export * from './constants/index.js';

// Utils
export * from './utils/index.js';

// IPC Protocol (shared between Primary Node and MCP Server)
export * from './ipc/index.js';

// Version
export const CORE_VERSION = '0.0.1';
