/**
 * @disclaude/worker-node
 *
 * Worker Node process for disclaude.
 *
 * This package will contain:
 * - Agent execution
 * - WebSocket client
 * - Scheduler
 * - File transfer client
 *
 * Code will be migrated from src/ in subsequent PRs.
 */

// Re-export types from @disclaude/core (Issue #1041)
export type {
  NodeType,
  BaseNodeConfig,
  WorkerNodeConfig,
  NodeCapabilities,
} from '@disclaude/core';

export { getNodeCapabilities } from '@disclaude/core';

// Placeholder - code will be migrated from src/ in subsequent issues
export const WORKER_NODE_VERSION = '0.0.1';
