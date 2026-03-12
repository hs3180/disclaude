/**
 * Nodes module - Worker Node for distributed architecture.
 *
 * The architecture supports worker node type:
 * - Worker Node: Worker node with execution-only capability
 *
 * Note: Primary Node has been moved to @disclaude/primary-node package.
 *
 * Usage:
 * ```typescript
 * import { WorkerNode } from './nodes/index.js';
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
export { WorkerNode, type WorkerNodeOptions, type WorkerNodeDependencies } from './worker-node.js';
export {
  type NodeType,
  type BaseNodeConfig,
  type NodeConfig,
  type WorkerNodeConfig,
  type ExecNodeInfo,
  type NodeCapabilities,
  getNodeCapabilities,
} from './types.js';

// Re-export from @disclaude/primary-node for backward compatibility (Issue #1040)
// These are used by WorkerNode to communicate with PrimaryNode
export {
  ExecNodeRegistry,
  WebSocketServerService,
  CardActionRouter,
  DebugGroupService,
  getDebugGroupService,
  type ConnectedExecNode,
  type WebSocketServerServiceConfig,
  type CardActionRouterConfig,
  type DebugGroupInfo,
} from '@disclaude/primary-node';
