/**
 * Execution Node Entry Point.
 *
 * This is the standalone entry point for running just the Execution Node.
 * It starts an HTTP server that listens for tasks from Communication Nodes.
 *
 * Usage:
 * ```bash
 * node dist/execution-entry.js --port 3001
 * ```
 *
 * Environment Variables:
 * - PORT: Server port (default: 3001)
 * - HOST: Server host (default: localhost)
 * - AUTH_TOKEN: Optional authentication token
 */

import { Config } from '../config/index.js';
import { HttpTransport } from '../transport/index.js';
import { ExecutionNode } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ExecutionEntry');

interface ExecutionEntryConfig {
  port: number;
  host: string;
  authToken?: string;
}

function parseArgs(): ExecutionEntryConfig {
  const args = process.argv.slice(2);

  let port = parseInt(process.env.PORT || '3001', 10);
  let host = process.env.HOST || 'localhost';
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

  logger.info({ config: { ...config, authToken: config.authToken ? '***' : undefined } }, 'Starting Execution Node');

  // Validate configuration
  const agentConfig = Config.getAgentConfig();
  if (!agentConfig.apiKey) {
    logger.error('No API key configured. Set ANTHROPIC_API_KEY or GLM_API_KEY environment variable.');
    process.exit(1);
  }

  // Create HTTP Transport
  const transport = new HttpTransport({
    mode: 'execution',
    port: config.port,
    host: config.host,
    authToken: config.authToken,
  });

  // Create Execution Node
  const execNode = new ExecutionNode({
    transport,
    isCliMode: false,
  });

  // Start Transport
  await transport.start();
  logger.info(`Execution Node listening on http://${config.host}:${config.port}`);

  // Start Execution Node (registers handlers)
  await execNode.start();

  logger.info('Execution Node started successfully');

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
