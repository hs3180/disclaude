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
 * @see Issue #1041 - Separate Worker Node code to @disclaude/worker-node
 */

// Re-export types from @disclaude/core
export type { WorkerNodeConfig } from '@disclaude/core';
export { getWorkerNodeCapabilities } from '@disclaude/core';

// Package version
export const WORKER_NODE_VERSION = '0.0.2';
