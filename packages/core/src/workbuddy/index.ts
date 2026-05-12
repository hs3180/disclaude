/**
 * WorkBuddy module — remote local-agent control infrastructure.
 *
 * @see Issue #3442
 */

export type {
  WorkBuddyArtifact,
  WorkBuddyCommand,
  WorkBuddyCommandPriority,
  WorkBuddyCommandResult,
  WorkBuddyConfig,
  WorkBuddyProjectConfig,
  WorkBuddyRegistration,
  WorkBuddyResultStatus,
  WorkBuddyStatus,
} from './types.js';

export {
  WorkBuddyManager,
  type WorkBuddyManagerOptions,
  type WorkBuddyTransport,
} from './workbuddy-manager.js';
