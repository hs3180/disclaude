#!/usr/bin/env node
/**
 * CLI entry point for @disclaude/worker-node
 *
 * Usage:
 *   disclaude-worker start [--comm-url URL] [--node-id ID] [--node-name NAME] [--config PATH]
 *
 * This starts the Worker Node which connects to a Primary Node via WebSocket
 * and executes agent tasks.
 *
 * @module worker-node/cli
 */

import {
  loadConfigFile,
  setLoadedConfig,
  applyGlobalEnv,
  createDefaultRuntimeContext,
  createLogger,
  Config,
} from '@disclaude/core';
import { WorkerNode, type WorkerNodeDependencies, type WorkerNodeConfig } from './index.js';

const logger = createLogger('WorkerNodeCLI');

/**
 * Parse command line arguments.
 */
interface CliOptions {
  command: 'start' | 'help';
  commUrl?: string;
  nodeId?: string;
  nodeName?: string;
  configPath?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { command: 'help' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === 'start') {
      options.command = 'start';
    } else if (arg === '--comm-url' || arg === '-u') {
      const value = args[++i];
      if (value) {
        options.commUrl = value;
      }
    } else if (arg === '--node-id' || arg === '-i') {
      const value = args[++i];
      if (value) {
        options.nodeId = value;
      }
    } else if (arg === '--node-name' || arg === '-n') {
      const value = args[++i];
      if (value) {
        options.nodeName = value;
      }
    } else if (arg === '--config' || arg === '-c') {
      const value = args[++i];
      if (value) {
        options.configPath = value;
      }
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    }
  }

  return options;
}

/**
 * Print usage information.
 */
function printUsage(): void {
  console.log(`
@disclaude/worker-node - Worker Node for disclaude

Usage:
  disclaude-worker start [options]

Commands:
  start    Start the Worker Node server

Options:
  --comm-url, -u URL     Primary Node URL (default: ws://localhost:3001)
  --node-id, -i ID        Node ID (auto-generated if not provided)
  --node-name, -n NAME    Display name for this worker
  --config, -c PATH       Path to configuration file
  --help, -h              Show this help message

Examples:
  disclaude-worker start
  disclaude-worker start --comm-url ws://primary:3001 --node-name worker-1
  disclaude-worker start --config /path/to/disclaude.config.yaml
`);
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.command === 'help' || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  // Load configuration if provided
  if (options.configPath) {
    logger.info({ path: options.configPath }, 'Loading configuration file');
    const config = loadConfigFile(options.configPath);
    if (!config._fromFile) {
      logger.error({ path: options.configPath }, 'Failed to load configuration file');
      console.error(`Error: Could not load configuration file: ${options.configPath}`);
      process.exit(1);
    }
    setLoadedConfig(config);
    logger.info({ path: config._source }, 'Configuration loaded successfully');
  }

  // Apply config env vars to process.env so main-process components can access them
  // Must be called AFTER setLoadedConfig() to ensure config is available
  applyGlobalEnv();

  // Set runtime context for agents (Issue #1839)
  // Provides dependency injection for BaseAgent methods (getGlobalEnv, getWorkspaceDir, etc.)
  // Without this, getGlobalEnv() returns {} and config env vars are silently dropped from SDK subprocess
  createDefaultRuntimeContext();

  // Get configuration values
  const commUrl = options.commUrl ?? 'ws://localhost:3001';
  const {nodeId} = options;
  const {nodeName} = options;

  logger.info({ commUrl, nodeId, nodeName }, 'Starting Worker Node');

  // Build WorkerNodeConfig
  const workerConfig: WorkerNodeConfig = {
    type: 'worker',
    primaryUrl: commUrl,
    nodeId,
    nodeName,
    reconnectInterval: 3000,
  };

  // Create dependency container
  // Note: In a real deployment, these dependencies would be provided by the main application
  // For CLI mode, we provide minimal implementations
  const dependencies: WorkerNodeDependencies = {
    getWorkspaceDir: () => Config.getWorkspaceDir(),
    createChatAgent: () => {
      throw new Error('ChatAgent not available in standalone worker mode');
    },
    createAgent: () => {
      throw new Error('Agent not available in standalone worker mode');
    },
    logger,
  };

  // Create WorkerNode with dependencies
  const workerNode = new WorkerNode({
    config: workerConfig,
    dependencies,
  });

  // Handle graceful shutdown
  let isShuttingDown = false;
  // eslint-disable-next-line require-await
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) {return;}
    isShuttingDown = true;
    logger.info('Shutting down Worker Node...');

    try {
      workerNode.stop();
      logger.info('Worker Node stopped');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Start WorkerNode
    await workerNode.start();

    logger.info({ commUrl, nodeId, nodeName }, 'Worker Node started successfully');
    console.log('Worker Node started');
    console.log(`Primary URL: ${commUrl}`);
    if (nodeId) {
      console.log(`Node ID: ${nodeId}`);
    }
    if (nodeName) {
      console.log(`Node Name: ${nodeName}`);
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to start Worker Node');
    console.error('Failed to start Worker Node:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  logger.error({ err: error }, 'Unhandled error in main');
  console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
