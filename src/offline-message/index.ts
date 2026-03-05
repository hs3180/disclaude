/**
 * Offline Message Module - Non-blocking communication system.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * This module provides the offline messaging system that allows agents
 * to send messages without blocking and trigger new tasks when users reply.
 *
 * Key Features:
 * - Send non-blocking messages with context
 * - Register callbacks for user replies
 * - Automatic timeout and cleanup
 * - Integration with AgentPool for task triggering
 *
 * Usage:
 * ```typescript
 * import {
 *   OfflineMessageManager,
 *   setOfflineMessageManager,
 *   getOfflineMessageManager,
 * } from './offline-message/index.js';
 *
 * // Initialize during app startup
 * const manager = new OfflineMessageManager({ agentPool });
 * setOfflineMessageManager(manager);
 *
 * // In MCP tool:
 * const manager = getOfflineMessageManager();
 * manager.register({
 *   messageId: 'om_xxx',
 *   chatId: 'oc_xxx',
 *   context: { ... },
 *   callback: { ... },
 * });
 * ```
 */

export {
  OfflineMessageManager,
  getOfflineMessageManager,
  setOfflineMessageManager,
} from './offline-message-manager.js';

export type {
  OfflineMessageEntry,
  OfflineMessageContext,
  OfflineMessageCallback,
  OfflineMessageManagerOptions,
  ReplyHandleResult,
  SendOfflineMessageResult,
} from './types.js';
