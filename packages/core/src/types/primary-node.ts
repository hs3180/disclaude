/**
 * Primary Node type definitions.
 *
 * This module defines the types used by Primary Node.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

/**
 * Node type identifier.
 * - primary: Main node with both communication and execution capabilities
 * - worker: Worker node with execution-only capability
 */
export type NodeType = 'primary' | 'worker';

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
 * REST channel configuration.
 * @see Issue #1028
 */
export interface RestChannelConfig {
  /** Enable/disable REST channel */
  enabled?: boolean;
  /** Port for REST API server */
  port?: number;
  /** Host for REST API server */
  host?: string;
  /** API prefix (e.g., '/api') */
  apiPrefix?: string;
  /** Authentication token for API access */
  authToken?: string;
  /** Enable CORS for cross-origin requests */
  enableCors?: boolean;
  /** Directory for file storage */
  fileStorageDir?: string;
  /** Maximum file size for uploads */
  maxFileSize?: number;
}

/**
 * File storage configuration for Primary Node.
 */
export interface FileStorageConfig {
  /** Directory for storing files */
  storageDir: string;
  /** Maximum file size in bytes */
  maxFileSize?: number;
  /** File expiration time in seconds */
  expirationSeconds?: number;
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
  /**
   * Full REST channel configuration from config file.
   * Takes precedence over restPort and restAuthToken if provided.
   * @see Issue #1028
   */
  restChannelConfig?: RestChannelConfig;
  /** Feishu App ID */
  appId?: string;
  /** Feishu App Secret */
  appSecret?: string;

  // Custom channels
  /** Custom communication channels to register */
  channels?: unknown[];

  // File storage
  /** File storage configuration */
  fileStorage?: FileStorageConfig;

  // Execution capabilities
  /** Enable local execution (default: true) */
  enableLocalExec?: boolean;

  // Message routing (Issue #659)
  /** Admin chat ID for debug/progress messages */
  adminChatId?: string;
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
