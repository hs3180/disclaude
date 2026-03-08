/**
 * Worker Node type definitions for disclaude.
 *
 * These types define the configuration and capabilities for Worker Nodes,
 * which are execution-only nodes that connect to Primary Nodes.
 */

/**
 * Node type identifier.
 * - primary: Main node with both communication and execution capabilities
 * - worker: Worker node with execution-only capability
 */
export type NodeType = 'primary' | 'worker';

/**
 * Base configuration for all node types.
 */
export interface BaseNodeConfig {
  /** Node type identifier */
  type: NodeType;
  /** Node ID (auto-generated if not provided) */
  nodeId?: string;
  /** Display name for this node */
  nodeName?: string;
}

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

/**
 * Node capability flags.
 */
export interface NodeCapabilities {
  /** Can handle communication channels (Feishu, REST, etc.) */
  communication: boolean;
  /** Can execute Agent tasks */
  execution: boolean;
}

/**
 * Get capabilities for a node type.
 */
export function getNodeCapabilities(type: NodeType): NodeCapabilities {
  switch (type) {
    case 'primary':
      return { communication: true, execution: true };
    case 'worker':
      return { communication: false, execution: true };
  }
}
