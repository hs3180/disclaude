/**
 * @disclaude/worker-node
 *
 * Worker Node process for disclaude.
 *
 * This package contains:
 * - WorkerNodeConfig type definition
 * - File transfer client (FileClient)
 * - (Future) Agent execution code
 * - (Future) WebSocket client
 * - (Future) Scheduler
 *
 * Note: The actual WorkerNode implementation is currently in src/nodes/worker-node.ts
 * and will be migrated in a subsequent phase as part of Issue #1041.
 *
 * @see Issue #1041 - Separate Worker Node code to @disclaude/worker-node
 */

// Re-export types from @disclaude/core
export type { WorkerNodeConfig } from '@disclaude/core';
export type {
  FileRef,
  FileUploadRequest,
  FileUploadResponse,
  FileDownloadResponse,
} from '@disclaude/core';
export { getWorkerNodeCapabilities } from '@disclaude/core';

// File transfer client
export { FileClient, type FileClientConfig } from './file-client/index.js';

// Package version
export const WORKER_NODE_VERSION = '0.0.4';
