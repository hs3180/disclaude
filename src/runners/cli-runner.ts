/**
 * CLI Runner.
 *
 * Runs Communication and Execution nodes as separate child processes.
 * After the prompt is executed, both processes are terminated.
 *
 * Architecture:
 * ```
 * CLI Runner (Parent Process)
 *    │
 *    ├── Child Process 1: Communication Node (HTTP Server)
 *    │       └── Listens on port for HTTP requests
 *    │
 *    └── Child Process 2: Execution Node (HTTP Client)
 *            └── Connects to Communication Node
 * ```
 */

import { spawn, ChildProcess } from 'node:child_process';
import http from 'node:http';
import { Config } from '../config/index.js';
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
 * Wait for server to be ready by checking health endpoint.
 */
async function waitForServer(port: number, maxAttempts = 50): Promise<boolean> {
  const url = `http://localhost:${port}/health`;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(url, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Status ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.setTimeout(500, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

/**
 * Send task to Communication Node via HTTP.
 */
async function sendTaskViaHttp(
  port: number,
  task: { taskId: string; chatId: string; message: string; messageId: string }
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(task);

    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/task',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 300000, // 5 minutes for long-running tasks
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch {
            resolve({ success: false, error: 'Invalid response from server' });
          }
        });
      }
    );

    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Request timeout' });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Run CLI mode - spawns two child processes for comm and exec nodes.
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

  let commProcess: ChildProcess | null = null;
  let execProcess: ChildProcess | null = null;

  try {
    // Spawn Communication Node
    logger.info({ port }, 'Starting Communication Node...');
    commProcess = spawn(
      process.execPath,
      [process.argv[1] || 'dist/cli-entry.js', 'start', '--mode', 'comm', '--port', String(port)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      }
    );

    commProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) logger.debug({ source: 'comm', output });
    });

    commProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) logger.debug({ source: 'comm', error: output });
    });

    // Wait for Communication Node to be ready
    const commReady = await waitForServer(port);
    if (!commReady) {
      throw new Error('Communication Node failed to start');
    }
    logger.info('Communication Node ready');

    // Spawn Execution Node
    logger.info('Starting Execution Node...');
    execProcess = spawn(
      process.execPath,
      [
        process.argv[1] || 'dist/cli-entry.js',
        'start',
        '--mode',
        'exec',
        '--communication-url',
        `http://localhost:${port}`,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      }
    );

    execProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) logger.debug({ source: 'exec', output });
    });

    execProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) logger.debug({ source: 'exec', error: output });
    });

    // Wait a bit for Execution Node to connect
    await new Promise((r) => setTimeout(r, 500));
    logger.info('Execution Node ready');

    // Send task to Communication Node via HTTP
    logger.info({ taskId: messageId }, 'Sending task...');
    const response = await sendTaskViaHttp(port, {
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
    throw error;
  } finally {
    // Stop both child processes
    logger.info('Stopping nodes...');

    if (execProcess) {
      execProcess.kill('SIGTERM');
      execProcess = null;
    }

    if (commProcess) {
      commProcess.kill('SIGTERM');
      commProcess = null;
    }

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
