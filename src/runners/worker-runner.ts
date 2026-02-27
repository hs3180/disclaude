/**
 * Worker Node Runner.
 *
 * Runs the Worker Node which handles only execution tasks.
 * Connects to a Primary Node via WebSocket.
 */

import { WorkerNode, type WorkerNodeConfig } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, type GlobalArgs } from '../utils/cli-args.js';

const logger = createLogger('WorkerRunner');

/**
 * Get Worker Node configuration from CLI args.
 */
export function getWorkerNodeConfig(globalArgs: GlobalArgs): WorkerNodeConfig {
  const primaryUrl = globalArgs.commUrl || 'ws://localhost:3001';

  return {
    type: 'worker',
    primaryUrl,
    nodeId: globalArgs.nodeId,
    nodeName: globalArgs.nodeName,
    reconnectInterval: 3000,
  };
}

/**
 * Run Worker Node (execution-only node that connects to Primary Node).
 *
 * This starts the Worker Node which:
 * 1. Connects to Primary Node via WebSocket
 * 2. Executes Agent tasks assigned by Primary Node
 * 3. Reports results back to Primary Node
 *
 * @param config - Optional configuration (uses CLI args if not provided)
 */
export async function runWorkerNode(config?: WorkerNodeConfig): Promise<void> {
  const globalArgs = parseGlobalArgs();
  const runnerConfig = config || getWorkerNodeConfig(globalArgs);

  logger.info({
    config: {
      primaryUrl: runnerConfig.primaryUrl,
      nodeId: runnerConfig.nodeId,
      nodeName: runnerConfig.nodeName,
    }
  }, 'Starting Worker Node');

  console.log('Initializing Worker Node...');
  console.log('Mode: Worker (Execution only)');
  console.log(`Primary URL: ${runnerConfig.primaryUrl}`);
  console.log();

  // Create Worker Node
  const workerNode = new WorkerNode(runnerConfig);

  // Start Worker Node
  await workerNode.start();

  logger.info('Worker Node started successfully');

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Worker Node...');
    console.log('\nShutting down Worker Node...');
    await workerNode.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Re-export type for external use
export type { WorkerNodeConfig };
