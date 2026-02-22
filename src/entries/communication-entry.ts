/**
 * Communication Node Entry Point (HTTP Server).
 *
 * This is the standalone entry point for running the Communication Node.
 * It starts an HTTP server that receives tasks from Feishu and processes them.
 *
 * Usage:
 * ```bash
 * node dist/communication-entry.js --port 3001
 * ```
 *
 * Environment Variables:
 * - PORT: Server port (default: 3001)
 * - HOST: Server host (default: 0.0.0.0)
 * - AUTH_TOKEN: Optional authentication token
 */

import { Config } from '../config/index.js';
import { HttpTransport } from '../transport/index.js';
import { ExecutionNode } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CommunicationEntry');

interface CommunicationEntryConfig {
  port: number;
  host: string;
  authToken?: string;
}

function parseArgs(): CommunicationEntryConfig {
  const args = process.argv.slice(2);

  let port = parseInt(process.env.PORT || '3001', 10);
  let host = process.env.HOST || '0.0.0.0';
  let authToken = process.env.AUTH_TOKEN;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--host' && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--auth-token' && args[i + 1]) {
      authToken = args[i + 1];
      i++;
    }
  }

  return { port, host, authToken };
}

async function main(): Promise<void> {
  const config = parseArgs();

  logger.info({ config: { ...config, authToken: config.authToken ? '***' : undefined } }, 'Starting Communication Node');

  // Validate configuration
  const agentConfig = Config.getAgentConfig();
  if (!agentConfig.apiKey) {
    logger.error('No API key configured. Set ANTHROPIC_API_KEY or GLM_API_KEY environment variable.');
    process.exit(1);
  }

  // Create HTTP Transport (Server mode)
  const transport = new HttpTransport({
    mode: 'communication',
    port: config.port,
    host: config.host,
    authToken: config.authToken,
  });

  // Create Execution Node (handles tasks locally with Pilot)
  const execNode = new ExecutionNode({
    transport,
    isCliMode: false,
  });

  // Start Transport (HTTP Server)
  await transport.start();
  logger.info(`Communication Node listening on http://${config.host}:${config.port}`);
  logger.info('Endpoints:');
  logger.info('  POST /task     - Receive tasks from Feishu');
  logger.info('  POST /callback - Receive messages from Execution Node');
  logger.info('  POST /control  - Receive control commands');
  logger.info('  GET  /health   - Health check');

  // Start Execution Node (registers handlers)
  await execNode.start();

  logger.info('Communication Node started successfully');

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Communication Node...');
    await execNode.stop();
    await transport.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error({ err: error }, 'Failed to start Communication Node');
  process.exit(1);
});
