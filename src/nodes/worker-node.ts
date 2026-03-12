/**
 * Worker Node - Re-export from @disclaude/worker-node package.
 *
 * This file provides backward compatibility by re-exporting WorkerNode
 * from the @disclaude/worker-node package.
 *
 * The actual implementation has been migrated to:
 * packages/worker-node/src/worker-node.ts
 *
 * @see Issue #1041 - Separate Worker Node code to @disclaude/worker-node
 */

export {
  WorkerNode,
  type WorkerNodeOptions,
  type WorkerNodeDependencies,
} from '@disclaude/worker-node';
