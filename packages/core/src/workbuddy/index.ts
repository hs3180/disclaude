/**
 * WorkBuddy module — local Agent process management.
 *
 * Provides process lifecycle management for WorkBuddy instances,
 * which are project-scoped Agent subprocesses running on the user's
 * local machine.
 *
 * @see Issue #3442
 * @module @disclaude/core/workbuddy
 */

export type {
  WorkBuddyStatus,
  WorkBuddyProjectConfig,
  WorkBuddyConfig,
  WorkBuddyInstance,
  WorkBuddyCommandType,
  WorkBuddyCommand,
  WorkBuddyCommandResponse,
  WorkBuddyCallbacks,
  WorkBuddyManagerOptions,
} from './types.js';

export { WorkBuddyManager } from './workbuddy-manager.js';
