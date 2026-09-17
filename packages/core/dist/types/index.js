/**
 * Core type definitions for disclaude.
 */
// Message level types (Issue #1040, Issue #1041)
export { MessageLevel, DEFAULT_USER_LEVELS, ALL_LEVELS, mapAgentMessageTypeToLevel, } from './messaging.js';
export { createFileRef, createInboundAttachment, createOutboundFile } from './file.js';
export { DEFAULT_CHANNEL_CAPABILITIES } from './channel.js';
export { SAFE_CHANNEL_ID_PATTERN, RESERVED_CHANNEL_IDS, } from './channel-plugin.js';
export { isUserMessage, isSystemMessage } from './message.js';
