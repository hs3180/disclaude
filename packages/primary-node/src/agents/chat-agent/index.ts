/**
 * ChatAgent barrel export.
 *
 * Issue #2345 Phase 3: Extracted implementation into separate modules.
 * This file re-exports the public API for backward compatibility.
 */

export { ChatAgent } from './chat-agent.js';
export type { ChatAgentCallbacks, ChatAgentConfig, MessageData } from './types.js';
