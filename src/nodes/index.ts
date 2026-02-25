/**
 * Nodes module - Communication node.
 *
 * The Communication node handles multiple channels (Feishu, REST, etc.)
 * and forwards prompts to Execution Node via WebSocket.
 *
 * Usage:
 * ```typescript
 * import { CommunicationNode } from './nodes/index.js';
 *
 * // Communication Node (handles multiple channels)
 * const commNode = new CommunicationNode({
 *   port: 3001,
 *   appId: '...',
 *   appSecret: '...',
 *   enableRestChannel: true,
 * });
 *
 * await commNode.start();
 * ```
 */

export { CommunicationNode, type CommunicationNodeConfig } from './communication-node.js';
