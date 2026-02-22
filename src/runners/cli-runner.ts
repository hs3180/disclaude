/**
 * CLI Runner.
 *
 * Runs both Communication and Execution nodes in a single process for CLI mode.
 * After the prompt is executed, both nodes are terminated.
 */

import { Config } from '../config/index.js';
import { HttpTransport } from '../transport/index.js';
import { CommunicationNode, ExecutionNode } from '../nodes/index.js';
import { CLIOutputAdapter, FeishuOutputAdapter, OutputAdapter } from '../utils/output-adapter.js';
import { createFeishuSender, createFeishuCardSender } from '../feishu/sender.js';
import { createLogger } from '../utils/logger.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import { parseGlobalArgs, getCliModeConfig, type CliModeConfig } from '../utils/cli-args.js';
import type { MessageContent } from '../transport/index.js';

const logger = createLogger('CLIRunner');

/**
 * Extended output adapter with optional lifecycle methods.
 */
interface ExtendedOutputAdapter extends OutputAdapter {
  finalize?: () => void;
  clearThrottleState?: () => void;
}

/**
 * ANSI color codes for terminal output.
 */
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

/**
 * Display colored text.
 */
function color(text: string, colorName: keyof typeof colors): string {
  return `${colors[colorName]}${text}${colors.reset}`;
}

/**
 * Run CLI mode - starts both nodes and executes a single prompt.
 *
 * @param config - CLI runner configuration
 */
export async function runCliMode(config: CliModeConfig): Promise<void> {
  const { prompt, feishuChatId, port } = config;

  // Create unique IDs for this CLI session
  const messageId = `cli-${Date.now()}`;
  const chatId = feishuChatId || 'cli-console';

  logger.info({ prompt: prompt.slice(0, 100), feishuChatId, port }, 'Starting CLI mode');

  // Create output adapter
  let adapter: ExtendedOutputAdapter;

  if (feishuChatId) {
    // Feishu mode: Use FeishuOutputAdapter
    const sendMessageFn = createFeishuSender();
    const sendCardFn = createFeishuCardSender();

    adapter = new FeishuOutputAdapter({
      sendMessage: async (chatId: string, msg: string) => {
        await sendMessageFn(chatId, msg);
      },
      sendCard: async (chatId: string, card: Record<string, unknown>) => {
        await sendCardFn(chatId, card);
      },
      chatId: feishuChatId,
      throttleIntervalMs: 2000,
    });
    logger.info({ chatId: feishuChatId }, 'Output will be sent to Feishu chat');
  } else {
    adapter = new CLIOutputAdapter();
  }

  // Create Communication Transport (HTTP Server)
  const commTransport = new HttpTransport({
    mode: 'communication',
    port,
    host: 'localhost',
  });

  // Create Execution Transport (HTTP Client)
  const execTransport = new HttpTransport({
    mode: 'execution',
    communicationUrl: `http://localhost:${port}`,
  });

  // Create Communication Node (handles task routing)
  const commNode = new CommunicationNode({
    transport: commTransport,
    appId: Config.FEISHU_APP_ID || '',
    appSecret: Config.FEISHU_APP_SECRET || '',
  });

  // Create Execution Node (handles Agent tasks)
  const execNode = new ExecutionNode({
    transport: execTransport,
    isCliMode: true,
  });

  // Register message handler for output
  commTransport.onMessage(async (content: MessageContent) => {
    switch (content.type) {
      case 'text':
        if (content.text) {
          await adapter.write(content.text);
        }
        break;
      case 'card':
        const cardJson = JSON.stringify(content.card, null, 2);
        await adapter.write(cardJson);
        break;
      case 'file':
        if (content.filePath) {
          await adapter.write(`\n📎 File created: ${content.filePath}\n`);
        }
        break;
    }
  });

  try {
    // Start Communication Node (HTTP Server)
    await commTransport.start();
    await commNode.start();
    logger.info({ port }, 'Communication Node started');

    // Start Execution Node (HTTP Client)
    await execTransport.start();
    await execNode.start();
    logger.info('Execution Node started');

    // Send task to Communication Node (which routes to Execution Node)
    const response = await commTransport.sendTask({
      taskId: messageId,
      chatId,
      message: prompt,
      messageId,
    });

    if (!response.success) {
      throw new Error(response.error || 'Task execution failed');
    }

    // Finalize output adapter if needed
    if (adapter.finalize) {
      adapter.finalize();
    }
    if (adapter.clearThrottleState) {
      adapter.clearThrottleState();
    }

    logger.info('CLI execution complete');
  } catch (error) {
    const enriched = handleError(error, {
      category: ErrorCategory.SDK,
      feishuChatId,
      userMessage: 'CLI execution failed. Please check your prompt and try again.'
    }, {
      log: true,
      customLogger: logger
    });

    console.log('');
    console.log(color(`Error: ${enriched.userMessage || enriched.message}`, 'red'));
    console.log('');
  } finally {
    // Stop both nodes
    logger.info('Stopping nodes...');
    await execNode.stop();
    await execTransport.stop();
    await commNode.stop();
    await commTransport.stop();
    logger.info('Nodes stopped');
  }
}

/**
 * Parse CLI arguments and run CLI mode.
 */
export async function runCli(args: string[]): Promise<void> {
  const globalArgs = parseGlobalArgs(args);
  const cliConfig = getCliModeConfig(globalArgs);

  // Handle feishu-chat-id "auto" special value
  let feishuChatId = cliConfig?.feishuChatId || globalArgs.feishuChatId;
  let chatIdSource: 'cli' | 'env' | undefined;

  if (feishuChatId === 'auto') {
    if (Config.FEISHU_CLI_CHAT_ID) {
      feishuChatId = Config.FEISHU_CLI_CHAT_ID;
      chatIdSource = 'env';
    } else {
      logger.error('FEISHU_CLI_CHAT_ID environment variable is not set');
      process.exit(1);
    }
  } else if (feishuChatId) {
    chatIdSource = 'cli';
  }

  // Show usage if no prompt provided
  if (!cliConfig || !cliConfig.prompt.trim()) {
    console.log('');
    console.log(color('═══════════════════════════════════════════════════════', 'cyan'));
    console.log(color('  Disclaude - CLI Mode', 'bold'));
    console.log(color('═════════════════════════════════════════════════════════', 'cyan'));
    console.log('');
    console.log(color('Usage:', 'bold'));
    console.log(`  disclaude --prompt ${color('<your prompt here>', 'yellow')}`);
    console.log('');
    console.log(color('Options:', 'bold'));
    console.log(`  --feishu-chat-id ${color('<chat_id|auto>', 'yellow')}  Send output to Feishu chat`);
    console.log(`                         ${color('auto', 'cyan')} = Use FEISHU_CLI_CHAT_ID env var`);
    console.log(`  --port ${color('<port>', 'yellow')}                Port for internal communication (default: 3001)`);
    console.log('');
    console.log(color('Example:', 'bold'));
    console.log(`  disclaude --prompt ${color('"Create a hello world file"', 'yellow')}`);
    console.log(`  disclaude --prompt ${color('"Analyze code"', 'yellow')} --feishu-chat-id ${color('oc_xxx', 'yellow')}`);
    console.log('');
    process.exit(0);
  }

  // Display prompt info (only in console mode)
  if (!feishuChatId) {
    console.log('');
    console.log(color('Prompt:', 'bold'), cliConfig.prompt);
    console.log(color('───────────────────────────────────', 'dim'));
    console.log('');
  } else {
    const sourceLabels: Record<string, string> = {
      cli: 'command line argument',
      env: 'environment variable (--feishu-chat-id auto)',
    };
    const sourceLabel = chatIdSource ? sourceLabels[chatIdSource] : 'unknown';
    logger.info({ chatId: feishuChatId, source: sourceLabel }, 'Using Feishu chat');
  }

  try {
    await runCliMode({
      prompt: cliConfig.prompt,
      feishuChatId,
      port: cliConfig.port,
    });
    process.exit(0);
  } catch (error) {
    const enriched = handleError(error, {
      category: ErrorCategory.SDK,
      userMessage: 'CLI execution failed. Please check your prompt and try again.'
    }, {
      log: true,
      customLogger: logger
    });

    console.log('');
    console.log(color(`Error: ${enriched.userMessage || enriched.message}`, 'red'));
    console.log('');
    process.exit(1);
  }
}

// Re-export type for external use
export type { CliModeConfig };
