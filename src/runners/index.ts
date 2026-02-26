/**
 * Runner functions for different operation modes.
 *
 * This module provides entry points for:
 * - Primary Node (primary): Self-contained node with comm + exec (recommended)
 * - Worker Node (worker): Execution-only node that connects to Primary
 * - Communication Node (comm): Legacy communication-only node
 * - Execution Node (exec): Legacy execution-only node
 */

// New unified architecture
export { runPrimaryNode, getPrimaryNodeConfig, type PrimaryNodeConfig } from './primary-runner.js';
export { runWorkerNode, getWorkerNodeConfig, type WorkerNodeConfig } from './worker-runner.js';

// Legacy runners for backward compatibility
export { runCommunicationNode } from './communication-runner.js';
export { runExecutionNode } from './execution-runner.js';
