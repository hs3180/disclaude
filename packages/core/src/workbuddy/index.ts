/**
 * WorkBuddy module — remote control of local development environments.
 *
 * @module core/workbuddy
 * @see Issue #3442
 */

export type {
  WorkBuddyConfig,
  WorkBuddyProjectConfig,
  WorkBuddyProcess,
  WorkBuddyProcessStatus,
  WorkBuddyChatRouting,
  WorkBuddyCommand,
  WorkBuddyResult,
  WorkBuddyHealth,
} from './types.js';

export { WorkBuddyManager } from './manager.js';
