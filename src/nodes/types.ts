/**
 * Node type definitions for Disclaude distributed architecture.
 *
 * This module defines the types used by Worker Node.
 * Note: Primary Node types have been moved to @disclaude/primary-node package.
 */

/**
 * Node type identifier.
 * - worker: Worker node with execution-only capability
 *
 * Note: 'primary' type has been moved to @disclaude/primary-node package.
 */
export type NodeType = 'worker';

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
 * Union type for all node configurations.
 */
export type NodeConfig = WorkerNodeConfig;

/**
 * Information about a connected execution node.
 */
export interface ExecNodeInfo {
  /** Node identifier */
  nodeId: string;
  /** Display name */
  name: string;
  /** Connection status */
  status: 'connected' | 'disconnected';
  /** Number of active chats assigned to this node */
  activeChats: number;
  /** Connection timestamp */
  connectedAt: Date;
  /** Whether this is a local execution capability */
  isLocal: boolean;
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
    case 'worker':
      return { communication: false, execution: true };
  }
}
