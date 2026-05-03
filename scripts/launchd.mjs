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
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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

// Issue #2934: Log directory moved from /tmp to ~/Library/Logs/disclaude
// for security (restrictive permissions) and pino-roll log rotation support.
// Application logs go through pino file transport with rotation;
// only stderr (for uncaught Node.js crashes) uses launchd's StandardErrorPath.
const LOG_DIR = resolve(homedir(), 'Library/Logs/disclaude');
const STDERR_LOG = resolve(LOG_DIR, 'launchd-stderr.log');
const APP_LOG = resolve(LOG_DIR, 'disclaude-combined.log');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_ENTRY = resolve(PROJECT_ROOT, 'packages/primary-node/dist/cli.js');

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
 * Issue #2934: Ensure log directory exists with restrictive permissions.
 * ~/Library/Logs/disclaude with 0o700 prevents global readability
 * (security concern from Issue #2898).
 */
function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    console.log(`Log directory created: ${LOG_DIR}`);
  }
}

// ---------------------------------------------------------------------------
// Plist generation
// ---------------------------------------------------------------------------

/**
 * Issue #2975: Detect caffeinate availability on macOS.
 * Returns the path to caffeinate binary, or null if not available.
 */
function getCaffeinatePath() {
  try {
    return execSync('which caffeinate', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Build the ProgramArguments array for the plist.
 *
 * Issue #2975: On macOS, wraps the node command with caffeinate -s to
 * prevent system sleep during service operation. When launchd stops the
 * service, caffeinate terminates automatically (along with the node child),
 * so no separate cleanup is needed.
 *
 * @param {string} nodePath - Absolute path to the node binary
 * @returns {string[]} ProgramArguments entries
 */
function buildProgramArguments(nodePath, caffeinatePath = getCaffeinatePath()) {
  const args = [];

  if (caffeinatePath) {
    args.push(caffeinatePath, '-s');
  }

  args.push(nodePath, CLI_ENTRY, 'start');
  return args;
}

function generatePlist() {
  const nodePath = getNodePath();
  const caffeinatePath = getCaffeinatePath();
  const programArgs = buildProgramArguments(nodePath, caffeinatePath);

  // Issue #2934: Removed StandardOutPath — application logs go through
  // pino file transport with pino-roll rotation (triggered by LOG_TO_FILE env var).
  // StandardErrorPath is kept for uncaught Node.js crash diagnostics.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${programArgs.map(a => `    <string>${a}</string>`).join('\n')}
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
    <key>LOG_TO_FILE</key>
    <string>true</string>
    <key>LOG_DIR</key>
    <string>${LOG_DIR}</string>
  </dict>
</dict>
</plist>
`;

  ensureLaunchAgentsDir();
  ensureLogDir();
  writeFileSync(PLIST_PATH, plist, 'utf-8');
  console.log(`Plist generated: ${PLIST_PATH}`);
  console.log(`  Node: ${nodePath}`);
  console.log(`  Entry: ${CLI_ENTRY}`);
  console.log(`  Caffeinate: ${caffeinatePath ? `enabled (${caffeinatePath} -s)` : 'not available'}`);
  console.log(`  CWD: ${PROJECT_ROOT}`);
  console.log(`  App log: ${APP_LOG} (pino-roll rotated)`);
  console.log(`  Stderr: ${STDERR_LOG} (launchd crash log)`);
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
  console.log(`=== app log (last ${n} lines) ===`);
  try {
    run(`tail -n ${n} ${APP_LOG}`, { silent: true });
  } catch {}
  console.log(`\n=== stderr (last ${n} lines) ===`);
  try {
    run(`tail -n ${n} ${STDERR_LOG}`, { silent: true });
  } catch {}
}

function cmdStatus() {
  const result = run(`launchctl list | grep ${LABEL}`, { allowFail: true, silent: true });
  if (result) {
    console.log(result.trim());
    console.log(`\nPlist: ${PLIST_PATH}`);
    console.log(`App log: ${APP_LOG} (pino-roll rotated)`);
    console.log(`Stderr: ${STDERR_LOG} (launchd crash log)`);
  } else {
    console.log('Service is NOT loaded.');
    console.log(`Plist: ${PLIST_PATH} (${existsSync(PLIST_PATH) ? 'exists' : 'not found'})`);
  }
}

// ---------------------------------------------------------------------------
// Exports (for testing)
// ---------------------------------------------------------------------------

export {
  LABEL,
  PLIST_FILENAME,
  PLIST_PATH,
  LOG_DIR,
  STDERR_LOG,
  APP_LOG,
  CLI_ENTRY,
  PROJECT_ROOT,
  getNodePath,
  getCaffeinatePath,
  buildProgramArguments,
  generatePlist,
  ensureLaunchAgentsDir,
  ensureLogDir,
  loadPlist,
  unloadPlist,
  build,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isMainModule = process.argv[1] === __filename;

if (isMainModule) {
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
`);
    process.exit(1);
  }

  commands[command]();
}
