/**
 * Agent Type Definitions - Unified interfaces for Agent classification.
 *
 * This module defines the core interfaces for the Agent architecture (Issue #1501):
 *
 * Simplified Architecture (ChatAgent-only):
 * - ChatAgent is the single Agent implementation in code
 * - Subagent functionality is defined via .md files in .claude/agents/
 * - Managed by Claude Code's native subagent mechanism (Issue #1410)
 *
 * Key Design Principles (Issue #1501):
 * 1. **ChatAgent as the only Agent implementation** - Single code-level Agent type
 * 2. **SkillAgent removed** - Skills handled via ChatAgent or .md-defined subagents
 * 3. **Subagent via .md files** - Defined in .claude/agents/, managed by Claude Code
 *
 * @module agents/types
 */
// ============================================================================
// Agent Type Guards
// ============================================================================
/**
 * Type guard to check if an agent is a ChatAgent.
 */
export function isChatAgent(agent) {
    return (typeof agent === 'object' &&
        agent !== null &&
        'type' in agent &&
        agent.type === 'chat');
}
/**
 * Type guard to check if an object is Disposable.
 */
export function isDisposable(obj) {
    return (typeof obj === 'object' &&
        obj !== null &&
        'dispose' in obj &&
        typeof obj.dispose === 'function');
}
// Global runtime context (set by main package)
let globalRuntimeContext = null;
/**
 * Set the runtime context for agents.
 * Must be called by main package before using any agents.
 *
 * @param ctx - Runtime context implementation
 */
export function setRuntimeContext(ctx) {
    globalRuntimeContext = ctx;
}
/**
 * Get the runtime context.
 * Throws if context is not set.
 *
 * @returns The runtime context
 * @throws Error if context not set
 */
export function getRuntimeContext() {
    if (!globalRuntimeContext) {
        throw new Error('Runtime context not set. Call setRuntimeContext() first.');
    }
    return globalRuntimeContext;
}
/**
 * Check if runtime context is set.
 * Useful for conditional behavior during migration.
 *
 * @returns true if context is set
 */
export function hasRuntimeContext() {
    return globalRuntimeContext !== null;
}
/**
 * Clear the runtime context (for testing).
 */
export function clearRuntimeContext() {
    globalRuntimeContext = null;
}
// ============================================================================
// Agent Factory Types (Issue #2941: Simplified to ChatAgent-only)
// ============================================================================
