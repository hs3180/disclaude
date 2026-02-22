/**
 * Communication Node Runner.
 *
 * Runs the Communication Node which handles Feishu WebSocket connections
 * and forwards tasks to Execution Node via HTTP.
 */

import { Config } from '../config/index.js';
import { HttpTransport } from '../transport/index.js';
import { CommunicationNode } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, getCommNodeConfig, type CommNodeConfig } from '../utils/cli-args.js';

const logger = createLogger('CommRunner');

/**
 * Run Communication Node (Feishu WebSocket handler with HTTP server).
 *
 * This starts an HTTP server that:
 * 1. Receives tasks from Feishu
 * 2. Forwards tasks to Execution Node
 * 3. Receives callbacks from Execution Node
 *
 * @param config - Optional configuration (uses CLI args if not provided)
 */
export async function runCommunicationNode(config?: CommNodeConfig): Promise<void> {
  const globalArgs = parseGlobalArgs();
  const runnerConfig = config || getCommNodeConfig(globalArgs);

  logger.info({
    config: {
      ...runnerConfig,
      authToken: runnerConfig.authToken ? '***' : undefined
    }
  }, 'Starting Communication Node');

  console.log('Initializing Communication Node...');
  console.log(`Mode: Communication (Feishu WebSocket + HTTP Server)`);
  console.log(`Port: ${runnerConfig.port}`);
  console.log(`Host: ${runnerConfig.host}`);
  console.log();

  // Validate Feishu configuration
  if (!Config.FEISHU_APP_ID || !Config.FEISHU_APP_SECRET) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required for Communication Node');
  }

  // Increase max listeners
  process.setMaxListeners(20);

  // Create HTTP Transport (Server mode)
  const transport = new HttpTransport({
    mode: 'communication',
    port: runnerConfig.port,
    host: runnerConfig.host,
    authToken: runnerConfig.authToken,
  });

  // Create Communication Node (handles Feishu WebSocket)
  const commNode = new CommunicationNode({
    transport,
    appId: Config.FEISHU_APP_ID,
    appSecret: Config.FEISHU_APP_SECRET,
  });

  // Start Transport (HTTP Server)
  await transport.start();
  logger.info(`Communication Node listening on http://${runnerConfig.host}:${runnerConfig.port}`);
  console.log('Endpoints:');
  console.log('  POST /task     - Receive tasks from Feishu');
  console.log('  POST /callback - Receive messages from Execution Node');
  console.log('  POST /control  - Receive control commands');
  console.log('  GET  /health   - Health check');
  console.log();

  // Start Communication Node
  await commNode.start();

  logger.info('Communication Node started successfully');
  console.log('✓ Communication Node ready');
  console.log();
  console.log('Waiting for Execution Node to connect...');
  console.log('  Execution Node should connect to: http://localhost:' + runnerConfig.port);

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Communication Node...');
    console.log('\nShutting down Communication Node...');
    await commNode.stop();
    await transport.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Re-export type for external use
export type { CommNodeConfig };
