/**
 * Nodes module - Communication and Execution nodes.
 *
 * This module provides the node implementations for the distributed
 * architecture of disclaude.
 *
 * Usage (single process mode):
 * ```typescript
 * import { LocalTransport, CommunicationNode, ExecutionNode } from './nodes/index.js';
 *
 * const transport = new LocalTransport();
 * const commNode = new CommunicationNode({ transport });
 * const execNode = new ExecutionNode({ transport });
 *
 * await transport.start();
 * await commNode.start();
 * await execNode.start();
 * ```
 */

export { CommunicationNode, type CommunicationNodeConfig } from './communication-node.js';
export { ExecutionNode, type ExecutionNodeConfig } from './execution-node.js';
