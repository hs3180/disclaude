/**
 * Types for the conversation management layer.
 *
 * These types define the interfaces for the conversation components,
 * following the single responsibility principle and enabling
 * agent-agnostic conversation management.
 */

// Re-export types for backward compatibility
export type { ConversationSessionManager } from './session-manager.js';
export type { SessionState } from './types.js';
export type { SessionCallbacks } from './types.js';
export type { CreateSessionOptions } from './types.js';
export type { ProcessMessageResult } from './types.js';
export type { SessionStats } from './types.js';
export type { MessageContext } from './types.js';

export * from './types.js';

// Re-export the timeout manager
export { SessionTimeoutManager } from './session-timeout-manager.js';

// Re-export session manager for timeout support
export { ConversationSessionManager } from './session-manager.js';
