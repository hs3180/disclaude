/**
 * Subagent Module - Issue #997
 *
 * Unified subagent creation and management.
 *
 * @example
 * ```typescript
 * import { initSubagentManager, spawnSubagent } from './agents/subagent';
 *
 * // Initialize the manager
 * initSubagentManager({
 *   sendMessage: async (chatId, text) => { ... },
 * });
 *
 * // Spawn a schedule agent
 * const handle = await spawnSubagent({
 *   type: 'schedule',
 *   name: 'daily-report',
 *   prompt: 'Generate daily report...',
 *   chatId: 'chat-123',
 * });
 *
 * // Spawn a skill agent
 * const handle2 = await spawnSubagent({
 *   type: 'skill',
 *   name: 'site-miner',
 *   prompt: 'Extract data from...',
 *   skillName: 'site-miner',
 * });
 * ```
 *
 * @module agents/subagent
 */

// Types
export {
  type SubagentType,
  type SubagentStatus,
  type IsolationMode,
  type SubagentOptions,
  type SubagentHandle,
  type SubagentMetrics,
  type SubagentResult,
  type SubagentCallbacks,
  type SubagentListFilter,
} from './types.js';

// Manager
export {
  SubagentManager,
  getSubagentManager,
  initSubagentManager,
  resetSubagentManager,
  spawnSubagent,
} from './manager.js';
