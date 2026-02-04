/**
 * CLI mode for Disclaude.
 * Executes a single prompt from command line arguments and exits.
 */

import * as fs from 'fs/promises';
import { InteractionAgent, OrchestrationAgent, ExecutionAgent, AgentDialogueBridge } from '../agent/index.js';
import { Config } from '../config/index.js';
import { CLIOutputAdapter, FeishuOutputAdapter } from '../utils/output-adapter.js';
import { createFeishuSender, createFeishuCardSender } from '../feishu/sender.js';
import { createLogger } from '../utils/logger.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import { extractText } from '../utils/sdk.js';
import { TaskTracker } from '../utils/task-tracker.js';

const logger = createLogger('CLI');

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
  // Create unique messageId for CLI session
  const messageId = `cli-${Date.now()}`;
  const chatId = feishuChatId || 'cli-console';
  const taskTracker = new TaskTracker();

  // === FLOW 1: InteractionAgent creates Task.md ===
  const taskPath = taskTracker.getDialogueTaskPath(messageId);

  const interactionAgent = new InteractionAgent({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
  });
  await interactionAgent.initialize();

  // Set context for Task.md creation
  // Use system username for CLI mode, fallback to 'cli-user'
  const userId = process.env.USER || process.env.USERNAME || 'cli-user';

  interactionAgent.setTaskContext({
    chatId,
    userId,
    messageId,
    taskPath,
  });

  // Run InteractionAgent to create Task.md
  logger.info({ messageId, taskPath }, 'Flow 1: InteractionAgent creating Task.md');
  for await (const msg of interactionAgent.queryStream(prompt)) {
    logger.debug({ content: msg.content }, 'InteractionAgent output');
  }

  // Verify Task.md was created
  try {
    await fs.access(taskPath);
  } catch {
    throw new Error(
      `InteractionAgent failed to create Task.md at ${taskPath}. ` +
      `The model may not have called the Write tool. ` +
      `Please check if the model supports tool calling properly.`
    );
  }

  logger.info({ taskPath }, 'Task.md created by InteractionAgent');

  // === FLOW 2: Create agents and dialogue bridge ===
  const orchestrationAgent = new OrchestrationAgent({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    permissionMode: 'bypassPermissions',
  });
  await orchestrationAgent.initialize();

  const executionAgent = new ExecutionAgent({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
  });
  await executionAgent.initialize();

  const bridge = new AgentDialogueBridge({
    orchestrationAgent,
    executionAgent,
  });

  // Create output adapter
  let adapter: CLIOutputAdapter | FeishuOutputAdapter;

  if (feishuChatId) {
    const sendToFeishu = createFeishuSender();
    const sendCardToFeishu = createFeishuCardSender();
    adapter = new FeishuOutputAdapter({
      sendMessage: sendToFeishu,
      sendCard: sendCardToFeishu,
      chatId: feishuChatId,
      throttleIntervalMs: 2000,
    });
    logger.info({ chatId: feishuChatId }, 'Output will be sent to Feishu chat');
  } else {
    adapter = new CLIOutputAdapter();
  }

  try {
    // Run dialogue loop (Flow 2)
    for await (const message of bridge.runDialogue(
      taskPath,
      prompt,
      chatId,
      messageId
    )) {
      const content = typeof message.content === 'string'
        ? message.content
        : extractText(message);

      if (!content) {
        continue;
      }

      // Use adapter to write message
      await adapter.write(content, message.messageType ?? 'text');
    }

  } finally {
    // Ensure final cleanup
    if ('finalize' in adapter) {
      (adapter as CLIOutputAdapter).finalize();
    }
    if ('clearThrottleState' in adapter) {
      (adapter as FeishuOutputAdapter).clearThrottleState();
    }
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
      logger.error('FEISHU_CLI_CHAT_ID environment variable is not set');
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
    console.log('  FEISHU_CLI_CHAT_ID    Chat ID used when --feishu-chat-id auto is specified');
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

    logger.info({ chatId: feishuChatId, source: sourceLabel }, 'Using Feishu chat');
  }

  try {
    await executeOnce(prompt, agentConfig, feishuChatId);
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
