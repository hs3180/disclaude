/**
 * @disclaude/core
 *
 * Shared core utilities, types, and interfaces for disclaude.
 *
 * This package contains:
 * - Type definitions (platform, websocket, file)
 * - Constants (deduplication, dialogue, api config)
 *
 * Note: Utility functions (logger, error-handler, retry) will be migrated
 * in a subsequent PR after resolving their dependencies.
 */

// Types
export * from './types/index.js';

// Node types
export * from './types/node.js';

// Constants
export * from './constants/index.js';

// Version
export const CORE_VERSION = '0.0.1';
