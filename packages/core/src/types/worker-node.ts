/**
 * Worker Node type definitions.
 *
 * This module defines the types used by Worker Node.
 *
 * @see Issue #1041 - Separate Worker Node code to @disclaude/worker-node
 */

import type { BaseNodeConfig, NodeCapabilities } from './primary-node.js';

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
 * Get capabilities for Worker Node type.
 */
export function getWorkerNodeCapabilities(): NodeCapabilities {
  return { communication: false, execution: true };
}
