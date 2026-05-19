/**
 * WorkBuddy module — remote local-agent control.
 *
 * WorkBuddy is a lightweight Agent instance running on the user's local machine.
 * disclaude (server) communicates with WorkBuddy via HTTP to execute local
 * operations like building, previewing, and publishing WeChat mini programs.
 *
 * Phase 1 (Issue #3442): Configuration, HTTP client, basic command routing.
 *
 * @module core/workbuddy
 */

export type {
  WorkBuddyStatus,
  WorkBuddyProjectConfig,
  WorkBuddyConfig,
  WorkBuddyCommand,
  WorkBuddyResponse,
  WorkBuddyHealth,
  WorkBuddyInstance,
  WorkBuddyManagerOptions,
} from './types.js';

export { WorkBuddyClient } from './workbuddy-client.js';
export { WorkBuddyManager } from './workbuddy-manager.js';
