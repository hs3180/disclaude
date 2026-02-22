/**
 * Nodes module - Communication node.
 *
 * The Communication node handles Feishu WebSocket connections
 * and runs a WebSocket server for Execution Node connections.
 *
 * Usage:
 * ```typescript
 * import { CommunicationNode } from './nodes/index.js';
 *
 * const commNode = new CommunicationNode({
 *   port: 3001,
 *   appId: '...',
 *   appSecret: '...',
 * });
 *
 * await commNode.start();
 * ```
 */

export { CommunicationNode, type CommunicationNodeConfig } from './communication-node.js';
