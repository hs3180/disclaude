#!/usr/bin/env node
/**
 * CLI entry point for @disclaude/primary-node
 *
 * Usage:
 *   disclaude-primary start [--config PATH]
 *
 * This starts the Primary Node with a REST channel for API access.
 * All configuration (port, host, etc.) is read from the config file.
 *
 * Issue #1594: Refactored to use ChannelManager for unified channel lifecycle.
 *
 * @module primary-node/cli
 */

import {
  loadConfigFile,
  setLoadedConfig,
  createLogger,
  Config,
  type IncomingMessage,
  type FeishuApiHandlers,
  type DisclaudeConfigWithChannels,
  type FileRef,
  createInboundAttachment,
  createControlHandler,
  type ControlHandlerContext,
  type MessageHandler,
} from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';
import { PrimaryNode } from './primary-node.js';
import { RestChannel, type RestChannelConfig } from './channels/rest-channel.js';
import { FeishuChannel, type FeishuChannelConfig } from './channels/feishu-channel.js';
import {
  buildInteractiveCard,
  buildActionPrompts,
  validateInteractiveParams,
} from './platforms/feishu/card-builders/index.js';
import { PrimaryAgentPool } from './primary-agent-pool.js';
import { createFeishuMessageBuilderOptions } from './messaging/adapters/feishu-message-builder.js';

const logger = createLogger('PrimaryNodeCLI');

/**
 * Parse command line arguments.
 */
interface CliOptions {
  command: 'start' | 'help';
  configPath?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { command: 'help' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === 'start') {
      options.command = 'start';
    } else if (arg === '--config' || arg === '-c') {
      const value = args[++i];
      if (value) {
        options.configPath = value;
      }
    } else if (arg === '--help') {
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
@disclaude/primary-node - Primary Node for disclaude

Usage:
  disclaude-primary start [options]

Commands:
  start    Start the Primary Node server

Options:
  --config, -c PATH       Path to configuration file
  --help                  Show this help message

Configuration:
  All settings (port, host, etc.) are read from the config file.
  See disclaude.config.yaml for available options.

Examples:
  disclaude-primary start
  disclaude-primary start --config /path/to/disclaude.config.yaml
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

  // Get configuration values from config file
  const rawConfig = Config.getRawConfig() as DisclaudeConfigWithChannels;
  const restChannelConfig = rawConfig.channels?.rest as {
    port?: number;
    host?: string;
    fileStorageDir?: string;
  } | undefined;

  // Check if Feishu is configured
  const hasFeishuConfig = Config.FEISHU_APP_ID && Config.FEISHU_APP_SECRET;
  const hasRestConfig = restChannelConfig?.port && restChannelConfig?.host && restChannelConfig?.fileStorageDir;

  // At least one channel must be configured
  if (!hasFeishuConfig && !hasRestConfig) {
    console.error('Error: At least one channel must be configured.');
    console.error('  - For Feishu: set feishu.appId and feishu.appSecret');
    console.error('  - For REST: set channels.rest.port, host, and fileStorageDir');
    process.exit(1);
  }

  const restPort = restChannelConfig?.port || 3000;
  const host = restChannelConfig?.host || '0.0.0.0';
  const fileStorageDir = restChannelConfig?.fileStorageDir || './data/rest-files';

  logger.info({ restPort, host, fileStorageDir, hasRestConfig, hasFeishuConfig }, 'Starting Primary Node');

  // Create PrimaryNode
  const primaryNode = new PrimaryNode({
    host,
    enableLocalExec: true,
  });

  // Get ChannelManager from PrimaryNode (Issue #1594: unified channel lifecycle)
  const channelManager = primaryNode.getChannelManager();

  // Create and register REST channel (if configured)
  let restChannel: RestChannel | undefined;
  if (hasRestConfig) {
    const restConfig: RestChannelConfig = {
      port: restPort,
      host,
      fileStorageDir,
    };
    restChannel = new RestChannel(restConfig);
    primaryNode.registerChannel(restChannel);
  }

  // Get agent configuration from loaded config (validates API key is available)
  try {
    const agentConfig = Config.getAgentConfig();
    logger.info(
      { provider: agentConfig.apiBaseUrl ? 'glm' : 'anthropic', model: agentConfig.model },
      'Agent configuration loaded'
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to get agent configuration');
    console.error('Error: No API key configured. Please set up disclaude.config.yaml with glm or anthropic settings.');
    process.exit(1);
  }

  // Create AgentPool for Primary Node with Feishu message builder options
  // Issue #1499: Channel-specific options are injected here, not in worker-node
  const agentPool = new PrimaryAgentPool({
    messageBuilderOptions: createFeishuMessageBuilderOptions(),
  });

  // Create unified control handler context
  const controlHandlerContext: ControlHandlerContext = {
    agentPool: {
      reset: (chatId: string) => agentPool.reset(chatId),
      stop: (chatId: string) => agentPool.stop(chatId),
    },
    node: {
      nodeId: primaryNode.getNodeId(),
      getExecNodes: () => primaryNode.getExecNodeRegistry().getNodes(),
      getDebugGroup: () => primaryNode.getDebugGroupService().getDebugGroup(),
      clearDebugGroup: () => primaryNode.getDebugGroupService().clearDebugGroup(),
    },
    logger,
  };

  // Create unified control handler for all channels
  const controlHandler = createControlHandler(controlHandlerContext);

  // Set up REST channel handlers (if configured)
  // Issue #1594: Use ChannelManager.setupHandlers() for unified handler wiring
  if (restChannel) {
    // Create PilotCallbacks for REST channel
    const createRestCallbacks = (_chatId: string): PilotCallbacks => ({
      sendMessage: async (chatId: string, text: string, parentMessageId?: string) => {
        await restChannel.sendMessage({
          chatId,
          type: 'text',
          text,
          threadId: parentMessageId,
        });
      },
      sendCard: async (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => {
        await restChannel.sendMessage({
          chatId,
          type: 'card',
          card,
          description,
          threadId: parentMessageId,
        });
      },
      // eslint-disable-next-line require-await
      sendFile: async (chatId: string, filePath: string) => {
        logger.warn({ chatId, filePath }, 'File sending not implemented for REST channel');
      },
      onDone: async (chatId: string, parentMessageId?: string) => {
        logger.info({ chatId }, 'Task completed');
        // Signal completion for sync mode
        await restChannel.sendMessage({
          chatId,
          type: 'done',
          threadId: parentMessageId,
        });
      },
    });

    // Create message handler for REST channel
    const restMessageHandler: MessageHandler = async (message: IncomingMessage) => {
      const { chatId, content, messageId, userId, metadata } = message;
      logger.info({ chatId, messageId, contentLength: content.length }, 'Processing message from REST channel');

      const callbacks = createRestCallbacks(chatId);
      const agent = agentPool.getOrCreateChatAgent(chatId, callbacks);

      // Extract context
      const senderOpenId = userId;
      const chatHistoryContext = metadata?.chatHistoryContext as string | undefined;

      try {
        agent.processMessage(chatId, content, messageId, senderOpenId, undefined, chatHistoryContext);
      } catch (error) {
        logger.error({ err: error, chatId, messageId }, 'Failed to process message');
        await restChannel.sendMessage({
          chatId,
          type: 'text',
          text: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        });
        await restChannel.sendMessage({
          chatId,
          type: 'done',
        });
      }
    };

    // Wire handlers via ChannelManager (Issue #1594)
    channelManager.setupHandlers(restChannel, restMessageHandler, controlHandler);
  }

  // Check if Feishu is configured and start Feishu Channel
  let feishuChannel: FeishuChannel | undefined;
  if (Config.FEISHU_APP_ID && Config.FEISHU_APP_SECRET) {
    logger.info('Starting Feishu Channel');

    const feishuChannelConfig: FeishuChannelConfig = {
      appId: Config.FEISHU_APP_ID,
      appSecret: Config.FEISHU_APP_SECRET,
    };

    feishuChannel = new FeishuChannel(feishuChannelConfig);
    primaryNode.registerChannel(feishuChannel);

    // Integrate passive mode into unified control handler context (Issue #1464)
    // Adapter layer: ControlHandlerContext uses isEnabled/setEnabled semantics,
    // while FeishuChannel exposes isPassiveModeDisabled/setPassiveModeDisabled.
    const feishuChannelRef = feishuChannel;
    controlHandlerContext.passiveMode = {
      isEnabled: (chatId: string) => !feishuChannelRef.isPassiveModeDisabled(chatId),
      setEnabled: (chatId: string, enabled: boolean) =>
        feishuChannelRef.setPassiveModeDisabled(chatId, !enabled),
    };

    // Create PilotCallbacks for Feishu channel
    const createFeishuCallbacks = (): PilotCallbacks => ({
      sendMessage: async (chatId: string, text: string, parentMessageId?: string) => {
        if (!feishuChannel) { throw new Error('Feishu channel not initialized'); }
        await feishuChannel.sendMessage({
          chatId,
          type: 'text',
          text,
          threadId: parentMessageId,
        });
      },
      sendCard: async (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => {
        if (!feishuChannel) { throw new Error('Feishu channel not initialized'); }
        await feishuChannel.sendMessage({
          chatId,
          type: 'card',
          card,
          description,
          threadId: parentMessageId,
        });
      },
      // eslint-disable-next-line require-await
      sendFile: async (chatId: string, filePath: string) => {
        logger.warn({ chatId, filePath }, 'File sending not fully implemented');
      },
      // eslint-disable-next-line require-await
      onDone: async (chatId: string, _parentMessageId?: string) => {
        logger.info({ chatId }, 'Task completed');
      },
    });

    // Create message handler for Feishu channel
    const feishuMessageHandler: MessageHandler = async (message: IncomingMessage) => {
      const { chatId, content, messageId, userId, metadata, attachments } = message;
      logger.info({ chatId, messageId, contentLength: content.length, hasAttachments: !!attachments }, 'Processing message from Feishu channel');

      const callbacks = createFeishuCallbacks();
      const agent = agentPool.getOrCreateChatAgent(chatId, callbacks);

      // Extract context
      const senderOpenId = userId;
      const chatHistoryContext = metadata?.chatHistoryContext as string | undefined;

      // Convert MessageAttachment[] to FileRef[] for agent processing
      const fileRefs: FileRef[] | undefined = attachments?.map((att) =>
        createInboundAttachment(att.fileName, chatId, message.messageType as 'image' | 'file' | 'media', {
          localPath: att.filePath,
          mimeType: att.mimeType,
          size: att.size,
          messageId: message.messageId,
        })
      );

      try {
        agent.processMessage(chatId, content, messageId, senderOpenId, fileRefs, chatHistoryContext);
      } catch (error) {
        logger.error({ err: error, chatId, messageId }, 'Failed to process message');
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!feishuChannel) { throw new Error('Feishu channel not initialized'); }
        await feishuChannel.sendMessage({
          chatId,
          type: 'text',
          text: `❌ Error: ${errorMsg}`,
        });
      }
    };

    // Wire handlers via ChannelManager (Issue #1594)
    channelManager.setupHandlers(feishuChannel, feishuMessageHandler, controlHandler);
  }

  // Handle graceful shutdown
  // Issue #1594: Use ChannelManager.stopAll() for unified channel lifecycle
  let isShuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) {return;}
    isShuttingDown = true;
    logger.info('Shutting down Primary Node...');

    try {
      agentPool.disposeAll();
      await channelManager.stopAll();
      await primaryNode.stop();
      logger.info('Primary Node stopped');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Start PrimaryNode
    await primaryNode.start();

    // Start all registered channels via ChannelManager (Issue #1594)
    await channelManager.startAll();

    // Log channel-specific startup info
    if (restChannel) {
      logger.info({ restPort, host }, 'REST Channel started');
      console.log(`REST Channel started on http://${host}:${restPort}`);
    }
    if (feishuChannel) {
      logger.info('Feishu Channel started');

      // Register Feishu handlers for IPC (Issue #1042)
      // This enables MCP Server tools to send messages via IPC
      const feishuHandlers: FeishuApiHandlers = {
        sendMessage: async (chatId: string, text: string, threadId?: string) => {
          await feishuChannel.sendMessage({
            chatId,
            type: 'text',
            text,
            threadId,
          });
        },
        sendCard: async (
          chatId: string,
          card: Record<string, unknown>,
          threadId?: string,
          description?: string
        ) => {
          await feishuChannel.sendMessage({
            chatId,
            type: 'card',
            card,
            threadId,
            description,
          });
        },
        uploadFile: async (chatId: string, filePath: string, threadId?: string) => {
          // File upload via sendMessage with type: 'file'
          await feishuChannel.sendMessage({
            chatId,
            type: 'file',
            filePath,
            threadId,
          });
          // Return minimal file info (actual implementation would need to upload and get file_key)
          return {
            fileKey: '',
            fileType: 'file',
            fileName: filePath.split('/').pop() || 'file',
            fileSize: 0,
          };
        },
        // Issue #1571: Build interactive card from raw parameters using extracted builder
        sendInteractive: async (chatId: string, params: {
          question: string;
          options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
          title?: string;
          context?: string;
          threadId?: string;
          actionPrompts?: Record<string, string>;
        }) => {
          const { question, options, title, context, threadId, actionPrompts } = params;

          // Validate params at IPC boundary (data comes from external MCP Server process)
          const validationError = validateInteractiveParams(params);
          if (validationError) {
            logger.warn({ chatId, error: validationError }, 'sendInteractive: invalid params');
            throw new Error(`Invalid interactive params: ${validationError}`);
          }

          // Build card using extracted builder (Primary Node owns the full card lifecycle)
          const card = buildInteractiveCard({ question, options, title, context });

          await feishuChannel.sendMessage({
            chatId,
            type: 'card',
            card,
            threadId,
          });

          // Build action prompts: use caller-provided prompts or generate defaults
          const resolvedActionPrompts = actionPrompts && Object.keys(actionPrompts).length > 0
            ? actionPrompts
            : buildActionPrompts(options);

          // Issue #1570: Return synthetic messageId for action prompt registration.
          // Real messageId propagation requires doSendMessage() changes (future phase).
          const syntheticMessageId = `interactive_${chatId}_${Date.now()}`;

          // TODO(Phase 3 #1572): Move action prompt registration to Primary Node.
          // Currently MCP Server handles registration using the returned messageId + actionPrompts.
          // The synthetic messageId means registration will work but won't match the real Feishu message.
          logger.debug(
            { chatId, syntheticMessageId, actionCount: Object.keys(resolvedActionPrompts).length },
            'sendInteractive: card sent (synthetic messageId — action prompts should be registered by caller)'
          );

          return { messageId: syntheticMessageId, actionPrompts: resolvedActionPrompts };
        },
      };
      primaryNode.registerFeishuHandlers(feishuHandlers);
      logger.info('Feishu IPC handlers registered');
    }

    logger.info({ hasRest: !!restChannel, hasFeishu: !!feishuChannel }, 'Primary Node started successfully');
    if (restChannel) {
      console.log(`Primary Node started on http://${host}:${restPort}`);
    } else {
      console.log('Primary Node started (Feishu only mode)');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to start Primary Node');
    console.error('Failed to start Primary Node:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  logger.error({ err: error }, 'Unhandled error in main');
  console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
