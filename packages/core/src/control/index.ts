/**
 * Control module.
 *
 * Provides unified control command handling for Primary and Worker nodes.
 *
 * @module control
 */

export * from './types.js';
export { createControlHandler } from './handler.js';
export { commandRegistry, getHandler } from './commands/index.js';
