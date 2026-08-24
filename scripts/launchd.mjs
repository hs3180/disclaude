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
import { realpathSync } from 'node:fs';
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
// for security (restrictive permissions).
// Issue #3416: Application writes to a single log file via pino.destination().
// Use system-level tools (newsyslog) for log rotation — see config/ for examples.
// Only stderr (for uncaught Node.js crashes) uses launchd's StandardErrorPath.
const LOG_DIR = resolve(homedir(), 'Library/Logs/disclaude');
const STDERR_LOG = resolve(LOG_DIR, 'launchd-stderr.log');
const STDOUT_LOG = resolve(LOG_DIR, 'launchd-stdout.log');
const APP_LOG = resolve(LOG_DIR, 'disclaude-combined.log');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_ENTRY = resolve(PROJECT_ROOT, 'packages/primary-node/dist/cli.js');

// Issue #4576: since #4280 Phase 3 the MCP tools' only transport is the
// PrimaryNode REST API (GET /api/ping on the HTTP API server). A launchd
// deployment started with bare `start` has no --api-port, so nothing listens
// on 9200 and every channel-mcp send tool reports「IPC 服务不可用」. The
// plist therefore enables the HTTP API server by default. The server binds
// localhost only (HttpApiServerConfig.host default) and GET routes are
// token-exempt, so this matches the security posture of interactive runs.
// Override with DISCLAUDE_LAUNCHD_API_PORT / DISCLAUDE_LAUNCHD_API_TOKEN.
const DEFAULT_API_PORT = 9200;

/**
 * Resolve the --api-port value for the plist (Issue #4576).
 *
 * Reads DISCLAUDE_LAUNCHD_API_PORT; valid range 1-65535 (same bounds as the
 * CLI parser in packages/primary-node/src/cli.ts). Falls back to 9200 — the
 * same default DISCLAUDE_REST_IPC_BASE_URL already assumes.
 *
 * @returns {number} port for --api-port
 */
export function resolveApiPort() {
  const raw = process.env.DISCLAUDE_LAUNCHD_API_PORT;
  if (raw) {
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port >= 1 && port <= 65535) {
      return port;
    }
    console.warn(`Warning: invalid DISCLAUDE_LAUNCHD_API_PORT "${raw}", using default ${DEFAULT_API_PORT}`);
  }
  return DEFAULT_API_PORT;
}

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

/**
 * Review of #4578: ProgramArguments / EnvironmentVariables values are
 * interpolated into plist XML. Paths and numbers are inherently safe, but
 * --api-token is the first free-text injection point — a token containing
 * & < > would produce an unparseable plist.
 *
 * @param {string} value - raw string to embed in plist XML
 * @returns {string} XML-escaped value
 */
export function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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
 * Issue #4576: appends --api-port (default 9200) so the PrimaryNode HTTP API
 * server is up for the REST-only MCP tools; --api-token only when provided
 * via DISCLAUDE_LAUNCHD_API_TOKEN (mirrors the interactive-run posture — GET
 * routes stay token-exempt, write routes gain Bearer auth).
 *
 * @param {string} nodePath - Absolute path to the node binary
 * @returns {string[]} ProgramArguments entries
 */
export function buildProgramArguments(nodePath, caffeinatePath = getCaffeinatePath()) {
  const args = [];

  if (caffeinatePath) {
    args.push(caffeinatePath, '-s');
  }

  args.push(nodePath, CLI_ENTRY, 'start', '--api-port', String(resolveApiPort()));

  const apiToken = process.env.DISCLAUDE_LAUNCHD_API_TOKEN;
  if (apiToken) {
    args.push('--api-token', apiToken);
  }
  return args;
}

/**
 * Review of #4578: when the port override differs from 9200, the MCP tools'
 * REST probe (ipc-utils.ts in core and mcp-server) would still default to
 * http://localhost:9200 unless DISCLAUDE_REST_IPC_BASE_URL is set. The plist
 * must propagate the override into the service's EnvironmentVariables so
 * both sides agree.
 *
 * @param {number} apiPort - the resolved --api-port value
 * @returns {string | null} base URL env value, or null when the default
 *   already matches (no env entry needed)
 */
export function resolveRestIpcBaseUrl(apiPort) {
  const override = process.env.DISCLAUDE_REST_IPC_BASE_URL;
  if (override) {
    // Operator set it explicitly — never clobber their value.
    return null;
  }
  return apiPort === DEFAULT_API_PORT ? null : `http://localhost:${apiPort}`;
}

function generatePlist() {
  const nodePath = getNodePath();
  const caffeinatePath = getCaffeinatePath();
  const programArgs = buildProgramArguments(nodePath, caffeinatePath);
  const apiPort = resolveApiPort();
  const restIpcBaseUrl = resolveRestIpcBaseUrl(apiPort);

  // Issue #2934: Application logs go through pino file transport
  // (triggered by LOG_TO_FILE env var). Issue #3416: pino-roll removed,
  // rotation delegated to system-level tools (newsyslog / logrotate).
  // Issue #3360: Added StandardOutPath as fallback — when pino file logging
  // fails, console.log/stdout output is still captured.
  // StandardErrorPath is kept for uncaught Node.js crash diagnostics.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${programArgs.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardErrorPath</key>
  <string>${STDERR_LOG}</string>

  <key>StandardOutPath</key>
  <string>${STDOUT_LOG}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH ?? '')}</string>
${restIpcBaseUrl ? `    <key>DISCLAUDE_REST_IPC_BASE_URL</key>\n    <string>${xmlEscape(restIpcBaseUrl)}</string>\n` : ''}    <key>HOME</key>
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
  console.log(`  API server: --api-port ${apiPort} (REST IPC for MCP tools; Issue #4576)`);
  console.log(`  REST IPC base URL env: ${restIpcBaseUrl ? `${restIpcBaseUrl} (injected so MCP tools probe the override)` : 'not set (default http://localhost:9200 already matches)'}`);
  console.log(`  API token: ${process.env.DISCLAUDE_LAUNCHD_API_TOKEN ? 'enabled (--api-token)' : 'not set (GET-only routes are token-exempt)'}`);
  console.log(`  CWD: ${PROJECT_ROOT}`);
  console.log(`  App log: ${APP_LOG} (use newsyslog for rotation)`);
  console.log(`  Stdout: ${STDOUT_LOG} (launchd fallback log)`);
  console.log(`  Stderr: ${STDERR_LOG} (launchd crash log)`);
  console.log(`  Note: an already-loaded service must be reloaded (npm run launchd:restart) to pick up the new plist.`);
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
  console.log(`\n=== stdout (last ${n} lines) ===`);
  try {
    run(`tail -n ${n} ${STDOUT_LOG}`, { silent: true });
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
    console.log(`App log: ${APP_LOG} (use newsyslog for rotation)`);
    console.log(`Stdout: ${STDOUT_LOG} (launchd fallback log)`);
    console.log(`Stderr: ${STDERR_LOG} (launchd crash log)`);
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

// Issue #4576: entry guard (same pattern as skills/issue-solver/scan.mjs) so
// the pure helpers (resolveApiPort, buildProgramArguments) can be imported by
// tests without triggering command dispatch. Compared via realpath so a
// symlinked invocation still matches.
const isMainEntry = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isMainEntry) {
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
