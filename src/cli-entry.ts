/**
 * CLI entry point for Disclaude.
 * Supports bot mode (feishu) and prompt mode (--prompt).
 */
import { runFeishu } from './bots.js';
import { runCli } from './cli/index.js';
import { Config } from './config/index.js';
import { promises as fs } from 'fs';

/**
 * Main CLI entry point.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check if prompt mode is requested
  const promptIndex = args.indexOf('--prompt');
  if (promptIndex !== -1) {
    const prompt = args[promptIndex + 1] || '';
    await runCli(['--prompt', prompt]);
    return;
  }

  // Bot mode: parse platform argument
  const platform = args[0];

  if (!platform) {
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('  Disclaude - Multi-platform Agent Bot');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
    console.log('Usage:');
    console.log('  disclaude feishu           Start Feishu/Lark bot');
    console.log('  disclaude --prompt <msg>   Execute single prompt');
    console.log('');
    process.exit(1);
  }

  // Validate agent configuration first
  try {
    Config.getAgentConfig();
  } catch (error) {
    console.error(`Configuration error:\n${error}`);
    console.log('\nPlease create a .env file based on .env.example');
    process.exit(1);
  }

  // Ensure workspace exists
  await fs.mkdir(Config.AGENT_WORKSPACE, { recursive: true }).catch(() => {
    // Ignore if already exists
  });

  // Show header
  console.log('='.repeat(50));
  console.log('  Disclaude - Agent Bot');
  console.log('='.repeat(50));
  console.log();

  // Run the selected platform
  if (platform === 'feishu') {
    // Validate Feishu config
    if (!Config.FEISHU_APP_ID || !Config.FEISHU_APP_SECRET) {
      console.error('Error: FEISHU_APP_ID and FEISHU_APP_SECRET are required');
      console.log('\nPlease set FEISHU_APP_ID and FEISHU_APP_SECRET in your .env file');
      process.exit(1);
    }
    await runFeishu();
  } else {
    console.error(`Error: Unknown platform "${platform}"`);
    console.log('\nAvailable platforms: feishu');
    console.log('Or use --prompt for single execution mode');
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
