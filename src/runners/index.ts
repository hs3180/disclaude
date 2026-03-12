/**
 * Runner functions for different operation modes.
 *
 * This module provides entry points for:
 * - Worker Node (worker): Execution-only node that connects to Primary
 *
 * Note: Primary Node has been moved to @disclaude/primary-node package.
 */

// Worker runner
export { runWorkerNode, getWorkerNodeConfig, type WorkerNodeConfig } from './worker-runner.js';
