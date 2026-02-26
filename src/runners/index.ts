/**
 * Runner functions for different operation modes.
 *
 * This module provides entry points for:
 * - Communication Node (comm): Feishu WebSocket handler with HTTP server
 * - Execution Node (exec): Pilot/Agent handler with HTTP client
 */

export { runCommunicationNode } from './communication-runner.js';
export { runExecutionNode } from './execution-runner.js';
