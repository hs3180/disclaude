/**
 * Communication Node Runner.
 *
 * Runs the Communication Node which handles Feishu WebSocket connections
 * and forwards prompts to Execution Node via HTTP.
 */

import { Config } from '../config/index.js';
import { CommunicationNode } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, getCommNodeConfig, type CommNodeConfig } from '../utils/cli-args.js';

const logger = createLogger('CommRunner');

/**
 * Run Communication Node (Feishu WebSocket handler).
 *
 * This starts the Communication Node which:
 * 1. Handles Feishu WebSocket connections
 * 2. Forwards prompts to Execution Node via HTTP POST /execute
 * 3. Sends responses back to Feishu users
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
  console.log(`Mode: Communication (Feishu WebSocket + HTTP Callback)`);
  console.log(`Port: ${runnerConfig.port}`);
  console.log(`Host: ${runnerConfig.host}`);
  console.log();

  // Validate Feishu configuration
  if (!Config.FEISHU_APP_ID || !Config.FEISHU_APP_SECRET) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required for Communication Node');
  }

  // Increase max listeners
  process.setMaxListeners(20);

  // Get execution node URL from config
  const executionUrl = runnerConfig.executionUrl || `http://localhost:${(runnerConfig.port || 3001) + 1}`;

  // Create Communication Node with execution URL
  const commNode = new CommunicationNode({
    executionUrl,
    appId: Config.FEISHU_APP_ID,
    appSecret: Config.FEISHU_APP_SECRET,
    callbackPort: runnerConfig.port,
    callbackHost: runnerConfig.host,
  });

  // Start Communication Node
  await commNode.start();

  logger.info('Communication Node started successfully');
  console.log('✓ Communication Node ready');
  console.log();
  console.log(`Forwarding prompts to: ${executionUrl}/execute`);
  console.log();

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Communication Node...');
    console.log('\nShutting down Communication Node...');
    await commNode.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Re-export type for external use
export type { CommNodeConfig };
