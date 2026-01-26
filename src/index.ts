/**
 * Main entry point for Disclaude.
 * Supports Discord, Feishu/Lark, or CLI mode.
 */
import { AgentClient } from './agent/client.js';
import { Config } from './config/index.js';
import { DiscordBot } from './discord/bot.js';
import { FeishuBot, SessionManager } from './feishu/index.js';
import { runCli } from './cli/index.js';

/**
 * Run Discord bot.
 */
async function runDiscord(): Promise<void> {
  console.log(`Initializing Discord bot (prefix: ${Config.DISCORD_COMMAND_PREFIX})...`);

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();

  // Initialize agent client
  console.log(`Connecting to agent (model: ${agentConfig.model})...`);
  const agent = new AgentClient({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    workspace: Config.AGENT_WORKSPACE,
    permissionMode: 'bypassPermissions', // Auto-approve actions for bot
  });
  await agent.ensureWorkspace();
  console.log('Agent client initialized!');

  // Create Discord bot
  const bot = new DiscordBot(agent, Config.DISCORD_COMMAND_PREFIX);

  // Run bot
  console.log('Connecting to Discord...');
  await bot.start(Config.DISCORD_BOT_TOKEN!);
}

/**
 * Run Feishu/Lark bot.
 */
async function runFeishu(): Promise<void> {
  console.log('Initializing Feishu/Lark bot...');

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();

  // Initialize agent client
  console.log(`Connecting to agent (model: ${agentConfig.model})...`);
  const agent = new AgentClient({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    workspace: Config.AGENT_WORKSPACE,
    permissionMode: 'bypassPermissions', // Auto-approve actions for bot
  });
  await agent.ensureWorkspace();
  console.log('Agent client initialized!');

  // Initialize session manager
  const sessionManager = new SessionManager();

  // Create Feishu bot
  const bot = new FeishuBot(agent, Config.FEISHU_APP_ID!, Config.FEISHU_APP_SECRET!, sessionManager);

  // Run bot (blocking)
  await bot.start();
}

/**
 * Run the selected platform.
 */
async function main(): Promise<void> {
  // Check if CLI mode is requested (command line arguments provided)
  const cliArgs = process.argv.slice(2);
  const isCliMode = cliArgs.length > 0;

  if (isCliMode) {
    // CLI mode: skip platform info and validation, run directly
    await runCli(cliArgs);
    return;
  }

  // Bot mode: show header and validate configuration
  console.log('='.repeat(50));
  console.log('  Disclaude - Agent Bot');
  console.log('='.repeat(50));
  console.log();

  // Validate configuration
  try {
    Config.validate();
  } catch (error) {
    console.error(`Configuration error:\n${error}`);
    console.log('\nPlease create a .env file based on .env.example');
    process.exit(1);
  }

  // Get platform info
  const platformInfo = Config.getPlatformInfo();
  console.log(`Platform: ${platformInfo}`);
  console.log();

  // Run the selected platform
  if (Config.PLATFORM === 'discord') {
    await runDiscord();
  } else if (Config.PLATFORM === 'feishu') {
    await runFeishu();
  } else {
    console.error(`Unknown platform: ${Config.PLATFORM}`);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\nGoodbye!');
  process.exit(0);
});

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
