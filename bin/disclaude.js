#!/usr/bin/env node
/**
 * Unified CLI entry point for disclaude.
 *
 * Routes subcommands to the appropriate package CLI:
 *   disclaude start [options]  → @disclaude/primary-node
 *   disclaude mcp [options]    → @disclaude/mcp-server
 *
 * Issue #3928 (part 1): Provides a single `disclaude` command so users can
 * run `npx disclaude start` or `npx disclaude mcp` without knowing internal
 * package names.
 *
 * @module disclaude/cli
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
disclaude - Multi-platform agent bot

Usage:
  disclaude <command> [options]

Commands:
  start [options]    Start the Primary Node server
  mcp [options]      Start the MCP Server (stdio mode)

Options:
  --config, -c PATH  Path to configuration file
  --help             Show help message

Examples:
  disclaude start --config ./disclaude.config.yaml
  disclaude mcp --config ./disclaude.config.yaml

Use 'disclaude <command> --help' for more information on a command.
`);
}

const ROOT = resolve(__dirname, "..");
const ROUTES = {
  start: resolve(ROOT, "packages/primary-node/dist/cli.js"),
  mcp: resolve(ROOT, "packages/mcp-server/dist/cli.js"),
};

if (!command || command === "--help" || command === "-h") {
  showHelp();
  process.exit(0);
}

const target = ROUTES[command];
if (!target) {
  console.error(`Unknown command: ${command}`);
  console.error("Run 'disclaude --help' for available commands.");
  process.exit(1);
}

const child = spawn(process.execPath, [target, ...args.slice(1)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
