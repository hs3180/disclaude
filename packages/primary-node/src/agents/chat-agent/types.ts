/**
 * Type definitions for ChatAgent.
 *
 * Issue #2717 Phase 1: ChatAgentCallbacks and ChatAgentConfig extracted to core.
 * This file re-exports from core for backward compatibility.
 * Issue #1492: MessageData moved to core package, re-exported here for backward compatibility.
 */

// Re-export types from core (Issue #2717 Phase 1)
export type { ChatAgentCallbacks, ChatAgentConfig } from '@disclaude/core';

// Re-export MessageData from core for backward compatibility (Issue #1492)
export type { MessageData } from '@disclaude/core';
