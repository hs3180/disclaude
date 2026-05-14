/**
 * WorkBuddy module — A2A (Agent-to-Agent) communication with local WorkBuddy agents.
 *
 * WorkBuddy enables remote control of lightweight agent instances running on
 * the user's local machine. disclaude (server-side) sends commands via HTTP
 * and receives results, enabling local toolchain integration (e.g., WeChat
 * DevTools CLI) without requiring the agent to run locally.
 *
 * @see Issue #3442
 * @module @disclaude/core/workbuddy
 */

export type {
  A2ACommand,
  A2ACommandType,
  A2AResponse,
  WorkBuddyCallbacks,
  WorkBuddyHealth,
  WorkBuddyStatus,
} from './types.js';

export { WorkBuddyClient } from './client.js';
export type { WorkBuddyClientOptions } from './client.js';

export { WorkBuddyManager } from './manager.js';
export type { WorkBuddyManagerOptions } from './manager.js';
