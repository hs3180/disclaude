/**
 * Worker Node type definitions for disclaude.
 *
 * These types define the configuration for Worker Nodes,
 * which are execution-only nodes that connect to Primary Nodes.
 *
 * Shared types (NodeType, BaseNodeConfig, NodeCapabilities, getNodeCapabilities)
 * are defined in primary-node.ts and re-exported here for convenience.
 */

import type { BaseNodeConfig } from './primary-node.js';

// Re-export shared types for convenience
export type { NodeType, BaseNodeConfig, NodeCapabilities } from './primary-node.js';
export { getNodeCapabilities } from './primary-node.js';

/**
 * Configuration for Worker Node.
 * Worker Node has only execution (exec) capability and connects to Primary Node.
 */
export interface WorkerNodeConfig extends BaseNodeConfig {
  type: 'worker';

  /** Primary Node WebSocket URL to connect to */
  primaryUrl: string;
  /** Reconnection interval in milliseconds (default: 3000) */
  reconnectInterval?: number;
  /**
   * Timeout for Feishu API requests in milliseconds (default: 30000).
   * Issue #1036: WebSocket request routing (WorkerNode → PrimaryNode)
   */
  feishuApiRequestTimeout?: number;
}
