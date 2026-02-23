/**
 * Nodes module - Communication node.
 *
 * The Communication node handles Feishu WebSocket connections
 * and forwards prompts to Execution Node via HTTP.
 *
 * Usage:
 * ```typescript
 * import { CommunicationNode } from './nodes/index.js';
 *
 * const commNode = new CommunicationNode({
 *   executionUrl: 'http://localhost:3002',
 *   appId: '...',
 *   appSecret: '...',
 * });
 *
 * await commNode.start();
 * ```
 */

export { CommunicationNode, type CommunicationNodeConfig } from './communication-node.js';
