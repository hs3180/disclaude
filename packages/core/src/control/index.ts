/**
 * Control module.
 *
 * Provides unified control command handling for the Primary node.
 *
 * @module control
 */

export * from './types.js';
export { createControlHandler } from './handler.js';
export { commandRegistry, getHandler } from './commands/index.js';
export { normalizeCommandData, createControlCommand } from './normalize.js';
