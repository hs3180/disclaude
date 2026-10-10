/**
 * Control module.
 *
 * Provides unified control command handling for the disclaude service.
 *
 * @module control
 */

export * from './types.js';
export { createControlHandler } from './handler.js';
export { commandRegistry, getHandler, getAvailableCommands } from './commands/index.js';
export { buildHelpMessage } from './commands/help.js';
export { normalizeCommandData, createControlCommand } from './normalize.js';
