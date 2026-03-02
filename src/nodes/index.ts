/**
 * Nodes module - Primary Node and Worker Node for distributed architecture.
 *
 * The architecture supports two node types:
 * - Primary Node: Main node with both communication and execution capabilities
 * - Worker Node: Worker node with execution-only capability
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

// Node types
export { PrimaryNode } from './primary-node.js';
export { WorkerNode } from './worker-node.js';
export {
  type NodeType,
  type BaseNodeConfig,
  type NodeConfig,
  type PrimaryNodeConfig,
  type WorkerNodeConfig,
  type ExecNodeInfo,
  type NodeCapabilities,
  getNodeCapabilities,
} from './types.js';

// Internal components (for PrimaryNode internal use)
export { ChannelManager } from './channel-manager.js';
export { TaskSuggestionService } from './task-suggestion-service.js';
