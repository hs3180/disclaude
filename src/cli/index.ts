/**
 * CLI mode for Disclaude.
 * Executes a single prompt from command line arguments and exits.
 */

import { AgentClient } from '../agent/client.js';
import { Config } from '../config/index.js';
import { CLIOutputAdapter } from '../utils/output-adapter.js';

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
 */
async function executeOnce(prompt: string, agentConfig: ReturnType<typeof Config.getAgentConfig>): Promise<void> {
  // Initialize agent client
  const agent = new AgentClient({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    permissionMode: 'bypassPermissions', // Auto-approve actions for CLI convenience
  });

  // Create output adapter for CLI
  const adapter = new CLIOutputAdapter();

  // Stream agent response
  for await (const message of agent.queryStream(prompt)) {
    const content = typeof message.content === 'string'
      ? message.content
      : agent.extractText(message);

    if (!content) {
      continue;
    }

    // Use adapter to write message
    adapter.write(content, message.messageType ?? 'text');
  }

  // Ensure final newline
  adapter.finalize();
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

  // Show usage if no prompt provided
  if (!prompt) {
    console.log('');
    console.log(color('═══════════════════════════════════════════════════', 'cyan'));
    console.log(color('  Disclaude - CLI Mode', 'bold'));
    console.log(color('═══════════════════════════════════════════════════', 'cyan'));
    console.log('');
    console.log(color('Usage:', 'bold'));
    console.log(`  node dist/index.js --prompt ${color('"your prompt here"', 'yellow')}`);
    console.log(`  npm start -- --prompt ${color('"your prompt here"', 'yellow')}`);
    console.log('');
    console.log(color('Example:', 'bold'));
    console.log(`  npm start -- --prompt ${color('"Create a hello world file"', 'yellow')}`);
    console.log('');
    process.exit(1);
  }

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();

  // Display prompt info
  console.log('');
  console.log(color('Prompt:', 'bold'), prompt);
  console.log(color('───────────────────────────────────────────────────', 'dim'));
  console.log('');

  try {
    await executeOnce(prompt, agentConfig);
  } catch (error) {
    console.log('');
    console.log(color(`Error: ${error instanceof Error ? error.message : String(error)}`, 'red'));
    console.log('');
    process.exit(1);
  }
}
