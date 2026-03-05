/**
 * Pilot - Re-export from pilot module for backward compatibility.
 *
 * Issue #697: Refactored pilot.ts into modular components.
 * This file re-exports everything from the pilot/ module for backward compatibility.
 */

export {
  Pilot,
  MessageBuilder,
  type MessageBuilderDeps,
  type PilotCallbacks,
  type PilotConfig,
  type MessageData,
} from './pilot/index.js';
