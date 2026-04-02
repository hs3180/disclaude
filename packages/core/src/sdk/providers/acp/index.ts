/**
 * ACP Provider Module Exports
 *
 * ACP (Agent Client Protocol) provider for connecting to
 * ACP-compatible AI agent subprocesses.
 *
 * @module sdk/providers/acp
 */

export { ACPProvider } from './provider.js';
export { ACPConnection } from './connection.js';
export { MessageBridge } from './types.js';
export { adaptACPUpdate, userInputToACPPrompt, formatStopReason } from './message-adapter.js';
export {
  adaptOptionsToSession,
  adaptMcpServers,
  parseACPConfigFromEnv,
  type ACPMcpServerConfig,
  type ACPSessionParams,
} from './options-adapter.js';
export type {
  ACPProviderConfig,
  ACPAgentConfig,
  ACPSessionState,
} from './types.js';
