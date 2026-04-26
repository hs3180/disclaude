/**
 * ChatAgent barrel export.
 *
 * Issue #2717 Phase 1: Migrated from @disclaude/worker-node to @disclaude/core.
 */

export { ChatAgent } from './chat-agent.js';
export type { ChatAgentCallbacks, ChatAgentConfig } from './types.js';
export { ChatHistoryLoader, type HistoryLoaderCallbacks } from './chat-history-loader.js';
export { AgentLoopManager, type LoopContext } from './agent-loop-manager.js';
