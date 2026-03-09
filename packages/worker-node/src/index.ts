/**
 * @disclaude/worker-node
 *
 * Worker Node process for disclaude.
 *
 * This package contains:
 * - WorkerNodeConfig type definition
 * - (Future) Agent execution code
 * - (Future) WebSocket client
 * - (Future) Scheduler
 * - (Future) File transfer client
 *
 * Note: The actual WorkerNode implementation is currently in src/nodes/worker-node.ts
 * and will be migrated in a subsequent phase as part of Issue #1041.
 *
 * @see Issue #1041 - Separate Worker Node code to @disclaude/worker-node
 */

// Re-export types from @disclaude/core
export type { WorkerNodeConfig } from '@disclaude/core';
export { getWorkerNodeCapabilities } from '@disclaude/core';

// Package version
export const WORKER_NODE_VERSION = '0.0.3';
