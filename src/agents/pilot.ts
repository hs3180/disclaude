/**
 * Pilot - Re-export from pilot module for backward compatibility.
 *
 * Issue #697: Refactored pilot.ts into pilot/ directory.
 * This file re-exports from the new module structure.
 */

// Re-export everything from the pilot module
export { Pilot, type PilotCallbacks, type PilotConfig, type MessageData } from './pilot/index.js';
