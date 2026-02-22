/**
 * Execution Node Entry Point (HTTP Client).
 *
 * This is the standalone entry point for running just the Execution Node.
 * It connects to a Communication Node and sends processed messages back.
 *
 * Usage:
 * ```bash
 * node dist/execution-entry.js --communication-url http://localhost:3001
 * ```
 *
 * Environment Variables:
 * - COMMUNICATION_URL: URL of the Communication Node
 * - AUTH_TOKEN: Optional authentication token
 */

import { Config } from '../config/index.js';
import { HttpTransport } from '../transport/index.js';
import { ExecutionNode } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ExecutionEntry');

interface ExecutionEntryConfig {
  communicationUrl: string;
  authToken?: string;
}

function parseArgs(): ExecutionEntryConfig {
  const args = process.argv.slice(2);

  let communicationUrl = process.env.COMMUNICATION_URL || 'http://localhost:3001';
  let authToken = process.env.AUTH_TOKEN;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--communication-url' && args[i + 1]) {
      communicationUrl = args[i + 1];
      i++;
    } else if (args[i] === '--auth-token' && args[i + 1]) {
      authToken = args[i + 1];
      i++;
    }
  }

  return { communicationUrl, authToken };
}

async function main(): Promise<void> {
  const config = parseArgs();

  logger.info(
    {
      config: {
        ...config,
        authToken: config.authToken ? '***' : undefined,
      },
    },
    'Starting Execution Node'
  );

  // Validate configuration
  const agentConfig = Config.getAgentConfig();
  if (!agentConfig.apiKey) {
    logger.error('No API key configured. Set ANTHROPIC_API_KEY or GLM_API_KEY environment variable.');
    process.exit(1);
  }

  // Create HTTP Transport (Client mode)
  const transport = new HttpTransport({
    mode: 'execution',
    communicationUrl: config.communicationUrl,
    authToken: config.authToken,
  });

  // Create Execution Node
  const execNode = new ExecutionNode({
    transport,
    isCliMode: false,
  });

  // Start Transport
  await transport.start();
  logger.info(`Execution Node connecting to ${config.communicationUrl}`);

  // Start Execution Node (registers handlers)
  await execNode.start();

  logger.info('Execution Node started successfully');
  logger.info('Ready to process tasks from Communication Node');

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Execution Node...');
    await execNode.stop();
    await transport.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error({ err: error }, 'Failed to start Execution Node');
  process.exit(1);
});
