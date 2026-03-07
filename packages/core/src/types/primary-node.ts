/**
 * Primary Node type definitions for Disclaude distributed architecture.
 *
 * This module defines the types used by Primary Node.
 * Related to Issue #1040: Separating Primary Node code to @disclaude/primary-node
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
 * Configuration for Primary Node.
 * Primary Node has both communication (comm) and execution (exec) capabilities.
 *
 * Note: This is a base configuration interface. Extended configuration with
 * channel-specific types (IChannel, RestChannelConfig, FileStorageConfig)
 * will be defined in @disclaude/primary-node package.
 */
export interface PrimaryNodeConfigBase extends BaseNodeConfig {
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

  // Execution capabilities
  /** Enable local execution (default: true) */
  enableLocalExec?: boolean;

  // Message routing (Issue #659)
  /** Admin chat ID for debug/progress messages */
  adminChatId?: string;
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
