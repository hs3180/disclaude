/**
 * ChatAgent barrel export.
 *
 * Issue #2717 Phase 1: Re-exported from @disclaude/core for backward compatibility.
 * Issue #2345 Phase 3: Extracted implementation into separate modules.
 * This file re-exports the public API for backward compatibility.
 *
 * Note: ChatAgentImpl is re-exported as ChatAgent to maintain backward compatibility
 * with existing code that imports { ChatAgent } from this module.
 */

export { ChatAgentImpl as ChatAgent } from '@disclaude/core';
export type { ChatAgentCallbacks, ChatAgentConfig, MessageData } from '@disclaude/core';
