/**
 * Worker Node Runner.
 *
 * Runs the Worker Node which handles only execution tasks.
 * Connects to a Primary Node via WebSocket.
 *
 * Issue #1041: Creates dependency container for WorkerNode.
 */

import {
  WorkerNode,
  type WorkerNodeDependencies,
  type WorkerNodeConfig,
} from '@disclaude/worker-node';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, type GlobalArgs } from '../utils/cli-args.js';
import { Config } from '../config/index.js';
import { AgentFactory, type PilotCallbacks } from '../agents/index.js';
import { TaskFlowOrchestrator, type MessageCallbacks } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { generateInteractionPrompt } from '@disclaude/mcp-server';
import type { Logger } from 'pino';

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
 * Create the dependency container for WorkerNode.
 *
 * Issue #1041: WorkerNode uses dependency injection to avoid
 * importing from src/ directory.
 */
function createWorkerNodeDependencies(): WorkerNodeDependencies {
  return {
    getWorkspaceDir: () => Config.getWorkspaceDir(),

    createChatAgent: (chatId: string, callbacks: PilotCallbacks) => {
      return AgentFactory.createChatAgent('pilot', chatId, callbacks);
    },

    createScheduleAgent: (chatId: string, callbacks: PilotCallbacks) => {
      return AgentFactory.createScheduleAgent(chatId, callbacks);
    },

    createTaskFlowOrchestrator: (messageCallbacks: MessageCallbacks, logger: Logger) => {
      const taskTracker = new TaskTracker();
      return new TaskFlowOrchestrator(taskTracker, messageCallbacks, logger);
    },

    generateInteractionPrompt,

    logger,
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

  // Create dependency container
  const dependencies = createWorkerNodeDependencies();

  // Create Worker Node with dependencies
  const workerNode = new WorkerNode({
    config: runnerConfig,
    dependencies,
  });

  // Start Worker Node
  await workerNode.start();

  logger.info('Worker Node started successfully');

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Worker Node...');
    console.log('\nShutting down Worker Node...');
    workerNode.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Re-export type for external use
export type { WorkerNodeConfig };
