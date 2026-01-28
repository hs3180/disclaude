/**
 * CLI mode for Disclaude.
 * Executes a single prompt from command line arguments and exits.
 */

import { AgentClient } from '../agent/client.js';
import { Config } from '../config/index.js';
import { CLIOutputAdapter, FeishuOutputAdapter } from '../utils/output-adapter.js';
import { createFeishuSender, createFeishuCardSender } from '../feishu/sender.js';

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
 * @param agentConfig - Agent configuration
 * @param feishuChatId - Optional Feishu chat ID to send output to (instead of console)
 */
async function executeOnce(
  prompt: string,
  agentConfig: ReturnType<typeof Config.getAgentConfig>,
  feishuChatId?: string
): Promise<void> {
  // Initialize agent client
  const agent = new AgentClient({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    permissionMode: 'bypassPermissions', // Auto-approve actions for CLI convenience
  });

  // Create output adapter based on mode
  let adapter: CLIOutputAdapter | FeishuOutputAdapter;

  if (feishuChatId) {
    // Feishu mode: create sender and adapter
    const sendToFeishu = createFeishuSender();
    const sendCardToFeishu = createFeishuCardSender();
    adapter = new FeishuOutputAdapter({
      sendMessage: sendToFeishu,
      sendCard: sendCardToFeishu,
      chatId: feishuChatId,
      throttleIntervalMs: 2000,
    });
    console.error(`[CLI] Output will be sent to Feishu chat: ${feishuChatId}`);
  } else {
    // Default CLI mode: output to console
    adapter = new CLIOutputAdapter();
  }

  // Stream agent response
  for await (const message of agent.queryStream(prompt)) {
    const content = typeof message.content === 'string'
      ? message.content
      : agent.extractText(message);

    if (!content) {
      continue;
    }

    // Use adapter to write message
    await adapter.write(content, message.messageType ?? 'text');
  }

  // Ensure final newline/cleanup
  if ('finalize' in adapter) {
    (adapter as CLIOutputAdapter).finalize();
  }
  if ('clearThrottleState' in adapter) {
    (adapter as FeishuOutputAdapter).clearThrottleState();
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
  // Only use this parameter to enable Feishu mode, not the environment variable
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
      console.error('Error: FEISHU_CLI_CHAT_ID environment variable is not set');
      process.exit(1);
    }
  } else if (feishuChatId) {
    chatIdSource = 'cli';
  }

  // Show usage if no prompt provided
  if (!prompt || prompt.trim() === '' || prompt === '--prompt') {
    console.log('');
    console.log(color('═══════════════════════════════════════════════════', 'cyan'));
    console.log(color('  Disclaude - CLI Mode', 'bold'));
    console.log(color('═══════════════════════════════════════════════════', 'cyan'));
    console.log('');
    console.log(color('Usage:', 'bold'));
    console.log(`  node dist/index.js --prompt ${color('"your prompt here"', 'yellow')}`);
    console.log(`  npm start -- --prompt ${color('"your prompt here"', 'yellow')}`);
    console.log('');
    console.log(color('Options:', 'bold'));
    console.log(`  --feishu-chat-id ${color('<chat_id|auto>', 'yellow')}  Send output to Feishu chat`);
    console.log(`                         ${color('auto', 'cyan')} = use FEISHU_CLI_CHAT_ID env var`);
    console.log('');
    console.log(color('Environment Variables:', 'bold'));
    console.log(`  FEISHU_CLI_CHAT_ID    Chat ID used when --feishu-chat-id auto is specified`);
    console.log('');
    console.log(color('Example:', 'bold'));
    console.log(`  npm start -- --prompt ${color('"Create a hello world file"', 'yellow')}`);
    console.log(`  npm start -- --prompt ${color('"Analyze code"', 'yellow')} --feishu-chat-id ${color('oc_xxx', 'yellow')}`);
    console.log(`  npm start -- --prompt ${color('"test"', 'yellow')} --feishu-chat-id ${color('auto', 'yellow')}`);
    console.log('');
    process.exit(1);
  }

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();

  // Display prompt info (only in console mode)
  if (!feishuChatId) {
    console.log('');
    console.log(color('Prompt:', 'bold'), prompt);
    console.log(color('───────────────────────────────────────────────────', 'dim'));
    console.log('');
  } else {
    // Show chat_id source
    const sourceLabels: Record<string, string> = {
      cli: 'command line argument',
      env: 'environment variable (--feishu-chat-id auto)',
    };
    const sourceLabel = chatIdSource ? sourceLabels[chatIdSource] : 'unknown';

    console.error(`[CLI] Using Feishu chat: ${feishuChatId}`);
    console.error(`[CLI] Source: ${sourceLabel}`);
  }

  try {
    await executeOnce(prompt, agentConfig, feishuChatId);
  } catch (error) {
    console.log('');
    console.log(color(`Error: ${error instanceof Error ? error.message : String(error)}`, 'red'));
    console.log('');
    process.exit(1);
  }
}
