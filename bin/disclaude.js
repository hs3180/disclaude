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
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0];

const ROOT = resolve(__dirname, "..");

function getVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, "package.json"), "utf8")
    );
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function showHelp() {
  console.log(
    [
      "disclaude - Multi-platform agent bot",
      "",
      "Usage:",
      "  disclaude <command> [options]",
      "",
      "Commands:",
      "  start [options]    Start the Primary Node server",
      "  mcp [options]      Start the MCP Server (stdio mode)",
      "",
      "Global Options:",
      "  --version, -v      Show version number",
      "  --help, -h         Show this help message",
      "",
      "Subcommand Options (passed through to the target command):",
      "  --config, -c PATH  Path to configuration file",
      "",
      "Examples:",
      "  disclaude start --config ./disclaude.config.yaml",
      "  disclaude mcp --config ./disclaude.config.yaml",
      "",
      "Use 'disclaude <command> --help' for more information on a command.",
    ].join("\n")
  );
}

const ROUTES = {
  start: resolve(ROOT, "packages/primary-node/dist/cli.js"),
  mcp: resolve(ROOT, "packages/mcp-server/dist/cli.js"),
};

if (!command || command === "--help" || command === "-h") {
  showHelp();
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  console.log(`disclaude v${getVersion()}`);
  process.exit(0);
}

const target = ROUTES[command];
if (!target) {
  console.error(`Unknown command: ${command}`);
  console.error("Run 'disclaude --help' for available commands.");
  process.exit(1);
}

if (!existsSync(target)) {
  console.error(`Error: Target not found at ${target}`);
  console.error('Did you forget to run "npm run build"?');
  process.exit(1);
}

const child = spawn(process.execPath, [target, ...args.slice(1)], {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (err) => {
  console.error(`Failed to start subprocess: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
