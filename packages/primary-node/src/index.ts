/**
 * @disclaude/primary-node
 *
 * Primary Node process for disclaude.
 *
 * This package contains:
 * - Channels (Feishu, REST)
 * - PrimaryNode implementation
 * - Platform adapters
 * - IPC server
 * - WebSocket server
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

// Re-export types from @disclaude/core
export type {
  NodeType,
  NodeCapabilities,
  BaseNodeConfig,
  RestChannelConfig,
  FileStorageConfig,
  PrimaryNodeConfig,
  PrimaryNodeExecInfo,
} from '@disclaude/core';

export { getNodeCapabilities } from '@disclaude/core';

// Placeholder - code will be migrated from src/ in subsequent issues
export const PRIMARY_NODE_VERSION = '0.0.1';
