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

  // Handle shutdown with detailed logging
  const shutdown = async (signal: string) => {
    // Capture stack trace to help identify signal source
    const stack = new Error('Signal source trace').stack;

    logger.info({
      signal,
      stack: stack?.split('\n').slice(1).join('\n')
    }, 'Received shutdown signal, shutting down Worker Node...');

    console.log(`\nReceived ${signal}, shutting down Worker Node...`);
    await workerNode.stop();

    logger.info('Worker Node stopped, exiting');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Re-export type for external use
export type { WorkerNodeConfig };
