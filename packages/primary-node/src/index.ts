/**
 * @disclaude/primary-node
 *
 * Primary Node process for disclaude.
 *
 * This package will contain:
 * - Channels (Feishu, REST)
 * - PrimaryNode implementation
 * - Platform adapters
 * - IPC server
 * - WebSocket server
 *
 * Code will be migrated from src/ in subsequent PRs.
 */

// Re-export types from @disclaude/core
export type {
  NodeType,
  BaseNodeConfig,
  PrimaryNodeConfigBase,
  NodeCapabilities,
} from '@disclaude/core';

export { getNodeCapabilities } from '@disclaude/core';

// Version
export const PRIMARY_NODE_VERSION = '0.0.1';
