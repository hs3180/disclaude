/**
 * Primary Node Runner.
 *
 * Runs the Primary Node which handles both communication and execution.
 * This is the recommended mode for single-machine deployment.
 */

import { Config } from '../config/index.js';
import { PrimaryNode, type PrimaryNodeConfig } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, type GlobalArgs } from '../utils/cli-args.js';

const logger = createLogger('PrimaryRunner');

/**
 * Get Primary Node configuration from CLI args.
 */
export function getPrimaryNodeConfig(globalArgs: GlobalArgs): PrimaryNodeConfig {
  return {
    type: 'primary',
    port: globalArgs.port,
    host: globalArgs.host,
    restPort: globalArgs.restPort,
    enableRestChannel: globalArgs.enableRestChannel,
    restAuthToken: globalArgs.restAuthToken,
    enableLocalExec: true, // Primary node always has local execution
  };
}

/**
 * Run Primary Node (self-contained node with comm + exec).
 *
 * This starts the Primary Node which:
 * 1. Handles multiple communication channels (Feishu, REST, etc.)
 * 2. Executes Agent tasks locally
 * 3. Runs WebSocket server for Worker Node connections
 * 4. Can run independently without requiring separate processes
 *
 * @param config - Optional configuration (uses CLI args if not provided)
 */
export async function runPrimaryNode(config?: PrimaryNodeConfig): Promise<void> {
  const globalArgs = parseGlobalArgs();
  const runnerConfig = config || getPrimaryNodeConfig(globalArgs);

  logger.info({
    config: {
      port: runnerConfig.port,
      host: runnerConfig.host,
      authToken: runnerConfig.restAuthToken ? '***' : undefined,
      restPort: runnerConfig.restPort,
      enableRestChannel: runnerConfig.enableRestChannel,
      enableLocalExec: runnerConfig.enableLocalExec,
    }
  }, 'Starting Primary Node');

  console.log('Initializing Primary Node...');
  console.log('Mode: Primary (Communication + Execution)');
  console.log();

  // Increase max listeners
  process.setMaxListeners(20);

  // Create Primary Node with all channels
  const primaryNode = new PrimaryNode({
    ...runnerConfig,
    appId: Config.FEISHU_APP_ID || undefined,
    appSecret: Config.FEISHU_APP_SECRET || undefined,
  });

  // Start Primary Node
  await primaryNode.start();

  logger.info('Primary Node started successfully');
  console.log('✓ Primary Node ready');
  console.log();

  // Handle shutdown with detailed logging
  const shutdown = async (signal: string) => {
    // Capture stack trace to help identify signal source
    const stack = new Error('Signal source trace').stack;

    logger.info({
      signal,
      stack: stack?.split('\n').slice(1).join('\n')
    }, 'Received shutdown signal, shutting down Primary Node...');

    console.log(`\nReceived ${signal}, shutting down Primary Node...`);
    await primaryNode.stop();

    logger.info('Primary Node stopped, exiting');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Re-export type for external use
export type { PrimaryNodeConfig };
