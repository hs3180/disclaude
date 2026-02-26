/**
 * Nodes module - Primary Node and Worker Node for distributed architecture.
 *
 * The new architecture supports two node types:
 * - Primary Node: Main node with both communication and execution capabilities
 * - Worker Node: Worker node with execution-only capability
 *
 * The legacy CommunicationNode is still available for backward compatibility.
 *
 * Usage:
 * ```typescript
 * import { PrimaryNode, WorkerNode } from './nodes/index.js';
 *
 * // Primary Node (self-contained, can run independently)
 * const primaryNode = new PrimaryNode({
 *   type: 'primary',
 *   port: 3001,
 *   appId: '...',
 *   appSecret: '...',
 *   enableLocalExec: true,
 * });
 * await primaryNode.start();
 *
 * // Worker Node (connects to Primary Node)
 * const workerNode = new WorkerNode({
 *   type: 'worker',
 *   primaryUrl: 'ws://localhost:3001',
 *   nodeId: 'worker-1',
 * });
 * await workerNode.start();
 * ```
 */

// New node types
export { PrimaryNode, type PrimaryNodeConfig } from './primary-node.js';
export { WorkerNode, type WorkerNodeConfig } from './worker-node.js';
export {
  type NodeType,
  type BaseNodeConfig,
  type NodeConfig,
  type ExecNodeInfo,
  type NodeCapabilities,
  getNodeCapabilities,
} from './types.js';

// Legacy export for backward compatibility
export { CommunicationNode, type CommunicationNodeConfig } from './communication-node.js';
