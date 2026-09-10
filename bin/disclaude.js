#!/usr/bin/env node
/**
 * Unified CLI entry point for disclaude.
 *
 * Routes subcommands to the appropriate package CLI:
 *   disclaude start [options]  → @disclaude/primary-node
 *   disclaude channel <command> → @disclaude/channel-cli
 *   disclaude chromium-cdp <cmd> → scripts/launchd.mjs chromium-cdp (Issue #4807)
 *
 * Issue #3928 (part 1): Provides a single `disclaude` command so users can
 * run `npx disclaude start` or `npx disclaude channel ...` without knowing internal
 * package names.
 *
 * @module disclaude/cli
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0];

const ROOT = resolve(__dirname, '..');

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function showHelp() {
  console.log(
    [
      'disclaude - Multi-platform agent bot',
      '',
      'Usage:',
      '  disclaude <command> [options]',
      '',
      'Commands:',
      '  start [options]    Start the Primary Node server',
      '  channel <command>  Send channel messages through the PrimaryNode',
      '  chromium-cdp <cmd> Manage the persistent Chromium CDP launchd service (Issue #4807)',
      '',
      'Global Options:',
      '  --version, -v      Show version number',
      '  --help, -h         Show this help message',
      '',
      'Subcommand Options (passed through to the target command):',
      '  --config, -c PATH  Path to configuration file',
      '',
      'Examples:',
      '  disclaude start --config ./disclaude.config.yaml',
      '',
      "Use 'disclaude <command> --help' for more information on a command.",
    ].join('\n')
  );
}

const ROUTES = {
  start: { file: resolve(ROOT, 'node_modules/@disclaude/primary-node/dist/cli.js') },
  channel: {
    file: resolve(ROOT, 'node_modules/@disclaude/channel-cli/dist/cli.js'),
    jsonOutput: !['help', '--help', '-h'].includes(args[1]),
  },
  // Issue #4807: routes to scripts/launchd.mjs chromium-cdp <cmd>. The launchd
  // script reads the service selector from argv[2], so we must PRESERVE it in
  // the forwarded args (launchd.mjs "chromium-cdp" <cmd>), not drop it.
  'chromium-cdp': { file: resolve(ROOT, 'scripts/launchd.mjs'), keepCommand: true },
};

if (!command || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  console.log(`disclaude v${getVersion()}`);
  process.exit(0);
}

const route = ROUTES[command];
if (!route) {
  console.error(`Unknown command: ${command}`);
  console.error("Run 'disclaude --help' for available commands.");
  process.exit(1);
}
const target = route.file;

if (!existsSync(target)) {
  console.error(`Error: Target not found at ${target}`);
  console.error('Did you forget to run "npm run build"?');
  process.exit(1);
}

// Forward user args. keepCommand routes (chromium-cdp) preserve the command in
// the forwarded argv because the target parses the service selector there.
const forwardArgs = route.keepCommand ? [command, ...args.slice(1)] : args.slice(1);
const child = spawn(process.execPath, [target, ...forwardArgs], {
  stdio: route.jsonOutput ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  env: process.env,
});

if (route.jsonOutput && child.stdout) {
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      (line.startsWith('{"ok":') ? process.stdout : process.stderr).write(`${line}\n`);
    }
  });
  child.stdout.on('end', () => {
    if (pending) {
      (pending.startsWith('{"ok":') ? process.stdout : process.stderr).write(pending);
    }
  });
}

child.on('error', (err) => {
  console.error(`Failed to start subprocess: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
