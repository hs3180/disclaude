/**
 * Communication Node Runner.
 *
 * Runs the Communication Node which handles multiple communication channels
 * (Feishu, REST, etc.) and runs a WebSocket server for Execution Node connections.
 */

import { Config } from '../config/index.js';
import { CommunicationNode } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, getCommNodeConfig, type CommNodeConfig } from '../utils/cli-args.js';

const logger = createLogger('CommRunner');

/**
 * Run Communication Node (multi-channel handler).
 *
 * This starts the Communication Node which:
 * 1. Handles multiple communication channels (Feishu, REST, etc.)
 * 2. Runs WebSocket server for Execution Node connections
 * 3. Forwards prompts and receives feedback via WebSocket
 *
 * @param config - Optional configuration (uses CLI args if not provided)
 */
export async function runCommunicationNode(config?: CommNodeConfig): Promise<void> {
  const globalArgs = parseGlobalArgs();
  const runnerConfig = config || getCommNodeConfig(globalArgs);

  logger.info({
    config: {
      port: runnerConfig.port,
      host: runnerConfig.host,
      authToken: runnerConfig.authToken ? '***' : undefined,
      restPort: runnerConfig.restPort,
      enableRestChannel: runnerConfig.enableRestChannel,
    }
  }, 'Starting Communication Node');

  console.log('Initializing Communication Node...');
  console.log('Mode: Communication (Multi-channel + WebSocket Server)');
  console.log();

  // Increase max listeners
  process.setMaxListeners(20);

  // Create Communication Node with all channels
  const commNode = new CommunicationNode({
    port: runnerConfig.port,
    host: runnerConfig.host,
    appId: Config.FEISHU_APP_ID || undefined,
    appSecret: Config.FEISHU_APP_SECRET || undefined,
    restPort: runnerConfig.restPort,
    enableRestChannel: runnerConfig.enableRestChannel,
    restAuthToken: runnerConfig.restAuthToken,
  });

  // Start Communication Node
  await commNode.start();

  logger.info('Communication Node started successfully');
  console.log('✓ Communication Node ready');
  console.log();
  console.log(`WebSocket Server: ws://${runnerConfig.host}:${runnerConfig.port}`);
  if (runnerConfig.enableRestChannel) {
    console.log(`REST API: http://${runnerConfig.host}:${runnerConfig.restPort || 3000}/api`);
  }
  console.log('Waiting for Execution Node to connect...');
  console.log();

  // Handle shutdown with detailed logging
  const shutdown = async (signal: string) => {
    // Capture stack trace to help identify signal source
    const stack = new Error('Signal source trace').stack;

    logger.info({
      signal,
      stack: stack?.split('\n').slice(1).join('\n')
    }, 'Received shutdown signal, shutting down Communication Node...');

    console.log(`\nReceived ${signal}, shutting down Communication Node...`);
    await commNode.stop();

    logger.info('Communication Node stopped, exiting');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Re-export type for external use
export type { CommNodeConfig };
