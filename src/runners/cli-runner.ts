/**
 * CLI Runner.
 *
 * For CLI mode, we directly use Execution Node (Pilot) without the Communication Node.
 * This is simpler and more efficient for one-shot command execution.
 *
 * Architecture:
 * ```
 * CLI Runner
 *    │
 *    └── Execution Node (Pilot Agent)
 *            └── Processes the prompt directly
 * ```
 *
 * For production Feishu bot mode, use the distributed architecture:
 * ```
 * Communication Node (HTTP Server) ←→ Execution Node (HTTP Client)
 * ```
 */

import { Config } from '../config/index.js';
import { Pilot, type PilotCallbacks } from '../agents/pilot.js';
import { CLIOutputAdapter, FeishuOutputAdapter, OutputAdapter } from '../utils/output-adapter.js';
import { createFeishuSender, createFeishuCardSender } from '../feishu/sender.js';
import { createLogger } from '../utils/logger.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import { parseGlobalArgs, getCliModeConfig, type CliModeConfig } from '../utils/cli-args.js';

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
 * Run CLI mode - directly executes prompt via Pilot without Communication Node.
 *
 * This is the simplest mode for CLI usage - no child processes needed.
 *
 * @param config - CLI runner configuration
 */
export async function runCliMode(config: CliModeConfig): Promise<void> {
  const { prompt, feishuChatId } = config;

  // Create unique IDs for this CLI session
  const messageId = `cli-${Date.now()}`;
  const chatId = feishuChatId || 'cli-console';

  logger.info({ prompt: prompt.slice(0, 100), feishuChatId }, 'Starting CLI mode');

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

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();

  // Create Pilot callbacks for output
  const callbacks: PilotCallbacks = {
    sendMessage: async (_chatId: string, text: string) => {
      await adapter.write(text);
    },
    sendCard: async (_chatId: string, card: Record<string, unknown>, _description?: string) => {
      const cardJson = JSON.stringify(card, null, 2);
      await adapter.write(cardJson);
    },
    sendFile: async (_chatId: string, filePath: string) => {
      await adapter.write(`\n📎 File created: ${filePath}\n`);
    },
  };

  // Create Pilot instance
  const pilot = new Pilot({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    isCliMode: true,
    callbacks,
  });

  try {
    // Execute the prompt
    logger.info({ taskId: messageId }, 'Executing prompt...');
    await pilot.executeOnce(chatId, prompt, messageId);

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
    throw error;
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
