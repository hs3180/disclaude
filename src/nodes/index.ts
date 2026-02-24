/**
 * Nodes module - Communication and Execution nodes.
 *
 * The Communication node handles multiple channels (Feishu, REST, etc.)
 * and forwards prompts to Execution Node via WebSocket.
 *
 * The Execution node handles Pilot/Agent tasks and connects to
 * Communication Node via WebSocket.
 *
 * Usage:
 * ```typescript
 * import { CommunicationNode, ExecutionNode } from './nodes/index.js';
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
 *
 * // Execution Node (handles Agent)
 * const execNode = new ExecutionNode({
 *   transport: new MyTransport(),
 * });
 *
 * await execNode.start();
 * ```
 */

export { CommunicationNode, type CommunicationNodeConfig } from './communication-node.js';
export { ExecutionNode, type ExecutionNodeConfig } from './execution-node.js';
