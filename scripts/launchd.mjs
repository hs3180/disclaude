#!/usr/bin/env node
/**
 * macOS launchd management script for disclaude.
 *
 * Replaces PM2 on macOS with native launchd process management.
 * Resolves TCC permission issues caused by PM2's fork process chain
 * (Issue #1957).
 *
 * Usage:
 *   node scripts/launchd.mjs <command>
 *
 * Commands:
 *   generate    Generate plist file (writes to ~/Library/LaunchAgents/)
 *   install     Generate + load (first-time setup)
 *   uninstall   Unload + remove plist
 *   start       Build + load
 *   stop        Unload (keep plist)
 *   restart     Build + unload + load
 *   logs        Tail log files
 *   status      Show service status
 *
 * @module scripts/launchd
 */

import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LABEL = 'com.disclaude.primary';
const PLIST_FILENAME = `${LABEL}.plist`;
const LAUNCHAGENTS_DIR = resolve(homedir(), 'Library/LaunchAgents');
const PLIST_PATH = resolve(LAUNCHAGENTS_DIR, PLIST_FILENAME);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_ENTRY = resolve(PROJECT_ROOT, 'packages/primary-node/dist/cli.js');

// Log directory: ~/Library/Logs/disclaude with pino-roll rotation
const LOG_DIR = resolve(homedir(), 'Library/Logs/disclaude');
const STDERR_LOG = resolve(LOG_DIR, 'disclaude-stderr.log');
const COMBINED_LOG = resolve(LOG_DIR, 'disclaude-combined.log');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNodePath() {
  try {
    return execSync('which node', { encoding: 'utf-8' }).trim();
  } catch {
    console.error('Error: node not found in PATH');
    process.exit(1);
  }
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
  } catch (e) {
    if (!opts.allowFail) throw e;
    return null;
  }
}

function ensureLaunchAgentsDir() {
  if (!existsSync(LAUNCHAGENTS_DIR)) {
    mkdirSync(LAUNCHAGENTS_DIR, { recursive: true });
  }
}

/**
 * Ensure log directory exists with restrictive permissions (0o700).
 * Prevents information leakage from log files containing API keys.
 * @see Issue #2898
 */
function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  } else {
    // Ensure correct permissions on existing directory (e.g. after upgrade)
    try {
      chmodSync(LOG_DIR, 0o700);
    } catch {
      // May fail if directory is not owned by current user; ignore silently
    }
  }
}

// ---------------------------------------------------------------------------
// Plist generation
// ---------------------------------------------------------------------------

function generatePlist() {
  const nodePath = getNodePath();

  // Ensure log directory with secure permissions before generating plist
  ensureLogDir();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${CLI_ENTRY}</string>
    <string>start</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardErrorPath</key>
  <string>${STDERR_LOG}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>LOG_DIR</key>
    <string>${LOG_DIR}</string>
  </dict>
</dict>
</plist>
`;

  ensureLaunchAgentsDir();
  writeFileSync(PLIST_PATH, plist, 'utf-8');
  console.log(`Plist generated: ${PLIST_PATH}`);
  console.log(`  Node: ${nodePath}`);
  console.log(`  Entry: ${CLI_ENTRY}`);
  console.log(`  CWD: ${PROJECT_ROOT}`);
  console.log(`  Logs (pino-roll): ${COMBINED_LOG} (rotated 10M × 30, gzip)`);
  console.log(`  Stderr (safety): ${STDERR_LOG}`);
}

// ---------------------------------------------------------------------------
// launchctl commands
// ---------------------------------------------------------------------------

function loadPlist() {
  if (!existsSync(PLIST_PATH)) {
    console.error(`Plist not found: ${PLIST_PATH}`);
    console.error('Run "generate" or "install" first.');
    process.exit(1);
  }
  run(`launchctl load ${PLIST_PATH}`);
  console.log('Service loaded.');
}

function unloadPlist() {
  if (!existsSync(PLIST_PATH)) {
    return; // Nothing to unload
  }
  run(`launchctl unload ${PLIST_PATH}`, { allowFail: true, silent: true });
  console.log('Service unloaded.');
}

function build() {
  console.log('Building...');
  run('npm run build', { cwd: PROJECT_ROOT });
}

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

function cmdGenerate() {
  generatePlist();
}

function cmdInstall() {
  generatePlist();
  loadPlist();
  console.log('\nService installed and started.');
}

function cmdUninstall() {
  unloadPlist();
  if (existsSync(PLIST_PATH)) {
    rmSync(PLIST_PATH);
    console.log(`Plist removed: ${PLIST_PATH}`);
  }
  console.log('Service uninstalled.');
}

function cmdStart() {
  build();
  generatePlist();
  loadPlist();
  console.log('\nService built and started.');
}

function cmdStop() {
  unloadPlist();
}

function cmdRestart() {
  unloadPlist();
  build();
  generatePlist();
  loadPlist();
  console.log('\nService restarted.');
}

function cmdLogs() {
  const lines = process.argv.find(a => a.startsWith('--lines='));
  const n = lines ? lines.split('=')[1] : '100';
  console.log(`=== combined (pino-roll, last ${n} lines) ===`);
  try {
    run(`tail -n ${n} ${COMBINED_LOG}`, { silent: true });
  } catch {
    console.log('(no combined log found — service may not have started yet)');
  }
  console.log(`\n=== stderr (last ${n} lines) ===`);
  try {
    run(`tail -n ${n} ${STDERR_LOG}`, { silent: true });
  } catch {
    console.log('(no stderr log found)');
  }
}

function cmdStatus() {
  const result = run(`launchctl list | grep ${LABEL}`, { allowFail: true, silent: true });
  if (result) {
    console.log(result.trim());
    console.log(`\nPlist: ${PLIST_PATH}`);
    console.log(`Logs (pino-roll): ${COMBINED_LOG} (rotated 10M × 30, gzip)`);
    console.log(`Stderr (safety): ${STDERR_LOG}`);
  } else {
    console.log('Service is NOT loaded.');
    console.log(`Plist: ${PLIST_PATH} (${existsSync(PLIST_PATH) ? 'exists' : 'not found'})`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

const commands = {
  generate: cmdGenerate,
  install: cmdInstall,
  uninstall: cmdUninstall,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  logs: cmdLogs,
  status: cmdStatus,
};

if (!command || !commands[command]) {
  console.log(`Usage: node scripts/launchd.mjs <command>

Commands:
  generate    Generate plist file
  install     Generate + load (first-time setup)
  uninstall   Unload + remove plist
  start       Build + load
  stop        Unload (keep plist)
  restart     Build + unload + load
  logs        Tail log files [--lines=N]
  status      Show service status

Log rotation:
  Logs use pino-roll: 10MB per file, 30 files, gzip compressed.
  Log directory: ~/Library/Logs/disclaude/ (mode 700)
`);
  process.exit(1);
}

commands[command]();
