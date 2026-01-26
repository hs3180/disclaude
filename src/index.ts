/**
 * Main entry point for Disclaude.
 * Supports Feishu/Lark or CLI mode.
 *
 * For CLI usage, use `disclaude` command (via cli-entry.ts).
 * This entry point is kept for backward compatibility (npm start).
 */
import { runCli } from './cli/index.js';

/**
 * Main entry point - for backward compatibility with npm start.
 * Shows usage hint since CLI mode is now handled by cli-entry.ts.
 */
async function main(): Promise<void> {
  // Check if CLI mode is requested (command line arguments provided)
  const cliArgs = process.argv.slice(2);

  if (cliArgs.length > 0) {
    // CLI mode: run directly
    await runCli(cliArgs);
    return;
  }

  // No arguments: show usage hint
  console.log('='.repeat(50));
  console.log('  Disclaude - Multi-platform Agent Bot');
  console.log('='.repeat(50));
  console.log('');
  console.log('For CLI usage, use the disclaude command:');
  console.log('  disclaude feishu           Start Feishu/Lark bot');
  console.log('  disclaude --prompt <msg>   Execute single prompt');
  console.log('');
  console.log('Or use npm start with arguments:');
  console.log('  npm start -- --prompt <msg>');
  console.log('');
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
