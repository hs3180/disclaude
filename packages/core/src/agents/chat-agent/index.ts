/**
 * ChatAgent barrel export.
 *
 * Issue #2717 Phase 1: Migrated from @disclaude/worker-node to @disclaude/core.
 * Issue #2345 Phase 3: Extracted implementation into separate modules.
 * This file re-exports the public API for backward compatibility.
 */

export { ChatAgent } from './chat-agent.js';
export type { ChatAgentCallbacks, ChatAgentConfig, MessageData } from './types.js';
export { ChatHistoryLoader, type HistoryLoaderCallbacks } from './chat-history-loader.js';
export { AgentLoopManager, type LoopContext } from './agent-loop-manager.js';
