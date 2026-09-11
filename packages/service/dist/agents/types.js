/**
 * Agent type definitions for disclaude service.
 *
 * Issue #2717: Migrated from @disclaude/worker-node to @disclaude/service.
 * Agents live with the service that owns their lifecycle.
 *
 * ChatAgentCallbacks defines the contract between ChatAgent and the
 * communication layer (channels). Each channel implementation provides
 * callbacks that satisfy this interface.
 */
export {};
