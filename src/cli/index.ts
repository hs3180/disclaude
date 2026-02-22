/**
 * CLI mode for Disclaude.
 * Executes a single prompt from command line arguments and exits.
 *
 * Note: CLI mode uses Pilot directly without Transport abstraction,
 * as it doesn't need the distributed architecture. The Transport layer
 * is only used when running as a bot service (Feishu mode).
 */
import { Config } from '../config/index.js';
import { CLIOutputAdapter, OutputAdapter } from '../utils/output-adapter.js';
import { createLogger } from '../utils/logger.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import { Pilot } from '../agents/pilot.js';

const logger = createLogger('CLI');

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
 * Execute a single prompt and exit.
 * @param prompt - The user prompt to execute
 * @param feishuChatId - Optional Feishu chat ID to send output to (instead of console)
 */
async function executeOnce(
  prompt: string,
  feishuChatId?: string
): Promise<void> {
  // Create unique messageId for CLI session
  const messageId = `cli-${Date.now()}`;
  const chatId = feishuChatId || 'cli-console';

  // Create output adapter
  let adapter: ExtendedOutputAdapter;

  if (feishuChatId) {
    // Feishu mode: Use FeishuOutputAdapter
    const { FeishuOutputAdapter } = await import('../utils/output-adapter.js');
    const { createFeishuSender, createFeishuCardSender } = await import('../feishu/sender.js');

    // Create sender functions (they return async functions)
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

  // Create Pilot instance
  const agentConfig = Config.getAgentConfig();
  const pilot = new Pilot({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    isCliMode: true,
    callbacks: {
      sendMessage: async (_chatId: string, msg: string) => {
        await adapter.write(msg);
      },
      sendCard: async (_chatId: string, card: Record<string, unknown>) => {
        const cardJson = JSON.stringify(card, null, 2);
        await adapter.write(cardJson);
      },
      sendFile: async (_chatId: string, filePath: string) => {
        await adapter.write(`\n📎 File created: ${filePath}\n`);
      },
    },
  });

  try {
    // Process message through Pilot (CLI mode: waits for completion)
    await pilot.executeOnce(chatId, prompt, messageId);

    // Finalize output adapter if needed
    if (adapter.finalize) {
      adapter.finalize();
    }
    if (adapter.clearThrottleState) {
      adapter.clearThrottleState();
    }

    logger.info('CLI execution complete');

    // Explicitly exit - MCP servers and other resources may keep process alive
    // OS will clean up resources
    process.exit(0);
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
    process.exit(1);
  }
}

/**
 * Run CLI mode with command line prompt.
 */
export async function runCli(args: string[]): Promise<void> {
  // Parse --prompt argument
  const promptIndex = args.indexOf('--prompt');
  const prompt = promptIndex !== -1 && args[promptIndex + 1]
    ? args[promptIndex + 1]
    : args.join(' '); // Fallback to direct argument

  // Parse --feishu-chat-id argument (optional)
  // Only use this parameter to enable Feishu mode, not environment variable
  const feishuChatIdIndex = args.indexOf('--feishu-chat-id');
  let feishuChatId = feishuChatIdIndex !== -1 && args[feishuChatIdIndex + 1]
    ? args[feishuChatIdIndex + 1]
    : undefined;

  // Special value "auto" means use environment variable
  let chatIdSource: 'cli' | 'env' | undefined;

  if (feishuChatId === 'auto') {
    // Use environment variable when --feishu-chat-id auto is specified
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
  if (!prompt || prompt.trim() === '' || prompt === '--prompt') {
    console.log('');
    console.log(color('═══════════════════════════════════════════════════════', 'cyan'));
    console.log(color('  Disclaude - CLI Mode', 'bold'));
    console.log(color('═════════════════════════════════════════════════════════', 'cyan'));
    console.log('');
    console.log(color('Usage:', 'bold'));
    console.log(`  node dist/index.js --prompt ${color('<your prompt here>', 'yellow')}`);
    console.log(`  npm start -- --prompt ${color('<your prompt here>', 'yellow')}`);
    console.log('');
    console.log(color('Options:', 'bold'));
    console.log(`  --feishu-chat-id ${color('<chat_id|auto>', 'yellow')}  Send output to Feishu chat`);
    console.log(`                         ${color('auto', 'cyan')} = Use FEISHU_CLI_CHAT_ID env var`);
    console.log('');
    console.log(color('Environment Variables:', 'bold'));
    console.log('  FEISHU_CLI_CHAT_ID    Chat ID used when --feishu-chat-id auto is specified');
    console.log('');
    console.log(color('Example:', 'bold'));
    console.log(`  npm start -- --prompt ${color('"Create a hello world file"', 'yellow')}`);
    console.log(`  npm start -- --prompt ${color('"Analyze code"', 'yellow')} --feishu-chat-id ${color('oc_xxx', 'yellow')}`);
    console.log('');
    process.exit(0);
  }

  // Display prompt info (only in console mode)
  if (!feishuChatId) {
    console.log('');
    console.log(color('Prompt:', 'bold'), prompt);
    console.log(color('───────────────────────────────────', 'dim'));
    console.log('');
  } else {
    // Show chat_id source
    const sourceLabels: Record<string, string> = {
      cli: 'command line argument',
      env: 'environment variable (--feishu-chat-id auto)',
    };
    const sourceLabel = chatIdSource ? sourceLabels[chatIdSource] : 'unknown';

    logger.info({ chatId: feishuChatId, source: sourceLabel }, 'Using Feishu chat');
  }

  try {
    await executeOnce(prompt, feishuChatId);
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
