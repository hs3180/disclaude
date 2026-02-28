/**
 * Node type definitions for Disclaude distributed architecture.
 *
 * This module defines the types used by Primary Node and Worker Node.
 */

import type { IChannel } from '../channels/index.js';
import type { FileStorageConfig } from '../file-transfer/node-transfer/file-storage.js';

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
 * Configuration for Primary Node.
 * Primary Node has both communication (comm) and execution (exec) capabilities.
 */
export interface PrimaryNodeConfig extends BaseNodeConfig {
  type: 'primary';

  // Communication capabilities
  /** Port for WebSocket server (default: 3001) */
  port?: number;
  /** Host for WebSocket server */
  host?: string;
  /** REST channel port (default: 3000) */
  restPort?: number;
  /** Enable REST channel */
  enableRestChannel?: boolean;
  /** REST channel auth token */
  restAuthToken?: string;
  /** Feishu App ID */
  appId?: string;
  /** Feishu App Secret */
  appSecret?: string;

  // Custom channels
  /** Custom channels to register */
  channels?: IChannel[];

  // Execution capabilities
  /** Enable local execution (default: true) */
  enableLocalExec?: boolean;

  // File storage
  /** File storage configuration */
  fileStorage?: FileStorageConfig;
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
}

/**
 * Union type for all node configurations.
 */
export type NodeConfig = PrimaryNodeConfig | WorkerNodeConfig;

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
  isLocal?: boolean;
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
