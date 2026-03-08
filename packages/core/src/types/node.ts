/**
 * Node type definitions for Disclaude distributed architecture.
 *
 * This module defines the types used by Primary Node and Worker Node.
 */

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
 * Configuration for Worker Node.
 * Worker Node has only execution capability.
 */
export interface WorkerNodeConfig {
  /** Node identifier (auto-generated if not provided) */
  nodeId?: string;
  /** Node display name */
  nodeName?: string;
  /** Primary Node WebSocket URL */
  primaryUrl: string;
  /** Reconnection interval in ms (default: 3000) */
  reconnectInterval?: number;
}

