#!/usr/bin/env node
/**
 * macOS launchd management script for disclaude.
 *
 * Replaces PM2 on macOS with native launchd process management.
 * Resolves TCC permission issues caused by PM2's fork process chain
 * (Issue #1957).
 *
 * Usage:
 *   node scripts/launchd.mjs <command>           # application service
 *   node scripts/launchd.mjs chromium-cdp <cmd>  # persistent Chromium CDP service
 *
 * Service Commands:
 *   generate    Generate plist file (writes to ~/Library/LaunchAgents/)
 *   install     Generate + load (first-time setup)
 *   uninstall   Unload + remove plist
 *   start       Build + load
 *   stop        Unload (keep plist)
 *   restart     Build + unload + load
 *   logs        Tail log files
 *   status      Show service status
 *
 * Isolated rehearsal (test services only):
 *   Invoke `node scripts/launchd.mjs isolated <command>`.
 *   Set `DISCLAUDE_LAUNCHD_ISOLATED=1`, a unique
 *   `DISCLAUDE_LAUNCHD_LABEL=com.disclaude.test.<suffix>`, and an absolute
 *   `DISCLAUDE_LAUNCHD_STATE_DIR`. `DISCLAUDE_LAUNCHD_CONFIG_PATH` must point to an absolute test config.
 *   Overrides are rejected without the
 *   isolation guard; production defaults remain unchanged.
 *
 * Chromium CDP Commands (Issue #4807):
 *   generate / install / uninstall / start / stop / restart / logs / status
 *   The `com.disclaude.chromium-cdp` service keeps a headless Chromium up with a
 *   persistent profile on a stable IPv4 CDP endpoint (default http://127.0.0.1:9222)
 *   for browser-use. Config via env or project-root .env (CHROMIUM_CDP_PORT /
 *   CHROMIUM_CDP_ADDRESS / CHROMIUM_CDP_PROFILE_DIR / CHROMIUM_CDP_HEADED /
 *   CHROMIUM_CDP_BINARY). Route through `disclaude chromium-cdp ...`.
 *
 * @module scripts/launchd
 */

import { execSync, execFileSync, execFile } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { realpathSync, accessSync, constants, statSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromiumConfigPath, loadChromiumConfig, saveChromiumConfig } from './chromium-config.mjs';
import { replaceChromiumFile, transitionChromium, chromiumListenerPids, isDescendant, waitChromiumReady } from './browser-service-state.mjs';
export { transitionChromium } from './browser-service-state.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LABEL = 'com.disclaude.service';

/** Resolve production defaults or guarded test-only launchd paths. */
export function resolveServiceLaunchdConfig(
  env = process.env,
  home = homedir(),
  isolatedSelector = false
) {
  const isolationFlag = env.DISCLAUDE_LAUNCHD_ISOLATED === '1';
  const hasIsolationIntent = Object.prototype.hasOwnProperty.call(
    env,
    'DISCLAUDE_LAUNCHD_ISOLATED'
  );
  const hasOverride = Boolean(
    env.DISCLAUDE_LAUNCHD_LABEL ||
    env.DISCLAUDE_LAUNCHD_STATE_DIR ||
    env.DISCLAUDE_LAUNCHD_CONFIG_PATH ||
    env.DISCLAUDE_LAUNCHD_ENTRY
  );
  if ((hasOverride || hasIsolationIntent) && (!isolationFlag || !isolatedSelector)) {
    throw new Error('Launchd path/label overrides require DISCLAUDE_LAUNCHD_ISOLATED=1');
  }
  if (isolatedSelector && !isolationFlag) {
    throw new Error('Isolated launchd command requires its isolation environment flag');
  }
  if (!isolatedSelector) {
    return {
      label: DEFAULT_LABEL,
      launchAgentsDir: resolve(home, 'Library/LaunchAgents'),
      logDir: resolve(home, 'Library/Logs/disclaude'),
    };
  }
  const label = env.DISCLAUDE_LAUNCHD_LABEL ?? '';
  const stateDir = env.DISCLAUDE_LAUNCHD_STATE_DIR ?? '';
  if (!/^com\.disclaude\.test\.[a-z0-9.-]+$/.test(label)) {
    throw new Error('Isolated launchd label must start with com.disclaude.test.');
  }
  if (!stateDir.startsWith('/')) {
    throw new Error('Isolated launchd state directory must be absolute');
  }
  if (env.DISCLAUDE_LAUNCHD_ENTRY && !env.DISCLAUDE_LAUNCHD_ENTRY.startsWith('/')) {
    throw new Error('Isolated launchd entry must be absolute');
  }
  if (!env.DISCLAUDE_LAUNCHD_CONFIG_PATH?.startsWith('/')) {
    throw new Error('Isolated launchd requires an absolute test config path');
  }
  return {
    label,
    launchAgentsDir: resolve(stateDir, 'LaunchAgents'),
    logDir: resolve(stateDir, 'logs'),
  };
}

const APP_SERVICE = resolveServiceLaunchdConfig(
  process.env,
  homedir(),
  ['isolated', 'chromium-isolated'].includes(process.argv[2])
);
const LABEL = APP_SERVICE.label;
const PLIST_FILENAME = `${LABEL}.plist`;
const LAUNCHAGENTS_DIR = APP_SERVICE.launchAgentsDir;
const PLIST_PATH = resolve(LAUNCHAGENTS_DIR, PLIST_FILENAME);

// Issue #2934: Log directory moved from /tmp to ~/Library/Logs/disclaude
// for security (restrictive permissions).
// Issue #3416: Application writes to a single log file via pino.destination().
// Use system-level tools (newsyslog) for log rotation — see config/ for examples.
// Only stderr (for uncaught Node.js crashes) uses launchd's StandardErrorPath.
const LOG_DIR = APP_SERVICE.logDir;
const STDERR_LOG = resolve(LOG_DIR, 'launchd-stderr.log');
const STDOUT_LOG = resolve(LOG_DIR, 'launchd-stdout.log');
const APP_LOG = resolve(LOG_DIR, 'disclaude-combined.log');
// Issue #4777: with LOG_ROTATE=true the app logs via pino-roll, which never
// creates the bare APP_LOG path — it writes disclaude-combined.<n>.log and
// keeps a `current.log` symlink pointed at the live one. Prefer that symlink
// when the bare path is absent so `logs`/`status` keep working under rotation.
// `dir` is a seam for tests — production callers use the LOG_DIR default.
export function resolveAppLog(dir = LOG_DIR) {
  const bare = resolve(dir, 'disclaude-combined.log');
  const rotated = resolve(dir, 'current.log');
  if (existsSync(bare)) return bare;
  if (existsSync(rotated)) return rotated;
  return bare;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_ENTRY = process.argv[2] === 'isolated' && process.env.DISCLAUDE_LAUNCHD_ENTRY
  ? process.env.DISCLAUDE_LAUNCHD_ENTRY
  : resolve(PROJECT_ROOT, 'bin/disclaude.js');

// Issue #4576: since #4280 Phase 3 the MCP tools' only transport is the
// DisclaudeService REST API (GET /api/ping on the HTTP API server). A launchd
// deployment started with bare `start` used to have no HTTP API. The plist
// enables it on an OS-assigned port by default. The server binds
// localhost only (HttpApiServerConfig.host default) and GET routes are
// token-exempt, so this matches the security posture of interactive runs.
// Override with DISCLAUDE_LAUNCHD_API_PORT / DISCLAUDE_LAUNCHD_API_TOKEN.
const DEFAULT_API_PORT = 0;

/**
 * Resolve the --api-port value for the plist (Issue #4576).
 *
 * Reads DISCLAUDE_LAUNCHD_API_PORT; valid range 0-65535 (same bounds as the
 * CLI parser). Falls back to 0 so parallel services do not contend.
 *
 * @returns {number} port for --api-port
 */
export function resolveApiPort() {
  const raw = process.env.DISCLAUDE_LAUNCHD_API_PORT;
  if (raw) {
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port >= 0 && port <= 65535) {
      return port;
    }
    console.warn(
      `Warning: invalid DISCLAUDE_LAUNCHD_API_PORT "${raw}", using default ${DEFAULT_API_PORT}`
    );
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
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
 * Issue #4576: appends --api-port (default 0) so the DisclaudeService HTTP API
 * server is up for the REST-only MCP tools; --api-token only when provided
 * via DISCLAUDE_LAUNCHD_API_TOKEN (mirrors the interactive-run posture — GET
 * routes stay token-exempt, write routes gain Bearer auth).
 *
 * @param {string} cliPath - Absolute path to the unified executable
 * @returns {string[]} ProgramArguments entries
 */
export function buildProgramArguments(cliPath = CLI_ENTRY, caffeinatePath = getCaffeinatePath()) {
  const args = [];

  if (caffeinatePath) {
    args.push(caffeinatePath, '-s');
  }

  args.push(cliPath, 'start', '--api-port', String(resolveApiPort()));

  const configPath = process.env.DISCLAUDE_LAUNCHD_CONFIG_PATH;
  if (configPath) {
    args.push('--config', configPath);
  }

  const apiToken = process.env.DISCLAUDE_LAUNCHD_API_TOKEN;
  if (apiToken) {
    args.push('--api-token', apiToken);
  }
  return args;
}

/**
 * A fixed operator override can be propagated into the service environment.
 * Port 0 cannot be published before listen; managed children inherit the
 * actual address that cli-main installs after the server reports ready.
 *
 * @param {number} apiPort - the resolved --api-port value
 * @returns {string | null} base URL env value, or null when the default
 *   already matches (no env entry needed)
 */
export function resolveRestChannelApiBaseUrl(apiPort) {
  const override = process.env.DISCLAUDE_API_BASE_URL;
  if (override) {
    // Operator set it explicitly — never clobber their value.
    return null;
  }
  return apiPort === 0 ? null : `http://127.0.0.1:${apiPort}`;
}

function generatePlist() {
  assertServiceMigrationComplete(LAUNCHAGENTS_DIR);
  const nodePath = getNodePath();
  const caffeinatePath = getCaffeinatePath();
  const programArgs = buildProgramArguments(CLI_ENTRY, caffeinatePath);
  const apiPort = resolveApiPort();
  const restChannelApiBaseUrl = resolveRestChannelApiBaseUrl(apiPort);

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
${programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
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
${restChannelApiBaseUrl ? `    <key>DISCLAUDE_API_BASE_URL</key>\n    <string>${xmlEscape(restChannelApiBaseUrl)}</string>\n` : ''}    <key>HOME</key>
    <string>${homedir()}</string>
${process.argv[2] === 'isolated' ? `    <key>LOCKFILE_PATH</key>\n    <string>${xmlEscape(resolve(LAUNCHAGENTS_DIR, 'disclaude.pid'))}</string>\n` : ''}    <key>NODE_ENV</key>
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
  console.log(
    `  Caffeinate: ${caffeinatePath ? `enabled (${caffeinatePath} -s)` : 'not available'}`
  );
  console.log(`  API server: --api-port ${apiPort} (REST API for MCP tools; Issue #4576)`);
  console.log(
    `  REST API base URL env: ${restChannelApiBaseUrl ? `${restChannelApiBaseUrl} (fixed override)` : 'set after dynamic HTTP listen readiness'}`
  );
  console.log(
    `  API token: ${process.env.DISCLAUDE_LAUNCHD_API_TOKEN ? 'enabled (--api-token)' : 'not set (GET-only routes are token-exempt)'}`
  );
  console.log(`  CWD: ${PROJECT_ROOT}`);
  console.log(`  App log: ${APP_LOG} (use newsyslog for rotation)`);
  console.log(`  Stdout: ${STDOUT_LOG} (launchd fallback log)`);
  console.log(`  Stderr: ${STDERR_LOG} (launchd crash log)`);
  console.log(
    `  Note: an already-loaded service must be reloaded (npm run launchd:restart) to pick up the new plist.`
  );
}

// Migration guard only: never boot out or delete an existing user service.
export function assertServiceMigrationComplete(directory) {
  const legacy = resolve(directory, 'com.disclaude.primary.plist');
  if (existsSync(legacy)) {
    throw new Error(`Retire the legacy launchd service before installing this one: ${legacy}. See docs/migrations/0.5.1-service.md; configuration and workspace must be preserved.`);
  }
}

// ---------------------------------------------------------------------------
// .env loader (Issue #4807)
// ---------------------------------------------------------------------------

/**
 * Load a `.env` file into process.env (dotenv-style, dependency-free).
 *
 * Used so operators can control the chromium-cdp service (notably the
 * persistent profile location) via `CHROMIUM_CDP_*` vars in a project-root
 * `.env` file, without installing dotenv. Precedence matches dotenv: an
 * already-set process.env value (real environment) always wins over the file.
 *
 * @param {string} file - absolute path to the .env file
 */
function loadDotEnv(file) {
  let txt;
  try {
    txt = readFileSync(file, 'utf-8');
  } catch {
    return; // no .env — fine, env vars only
  }
  for (const rawLine of txt.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let key = line.slice(0, eq).trim();
    key = key.replace(/^['"]|['"]$/g, '');
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Configuration is loaded only at command dispatch, never on module import.

// ---- chromium-cdp service constants -------------------------------------
// Issue #4807: a launchd-hosted Chromium that exposes a STABLE CDP endpoint
// (default 127.0.0.1:9222, IPv4) for browser-use / X daily digest, with a
// persistent profile so login state survives restarts, and KeepAlive so a
// crash auto-relaunches. This is the macOS host-side counterpart of the Docker
// `disclaude-chromium` service (docs/cdp-endpoint.md, #4496).
const LABEL_CHROMIUM = process.argv[2] === 'chromium-isolated'
  ? APP_SERVICE.label : 'com.disclaude.chromium-cdp';
const PLIST_FILENAME_CHROMIUM = `${LABEL_CHROMIUM}.plist`;
const CR_PLIST_PATH = resolve(LAUNCHAGENTS_DIR, PLIST_FILENAME_CHROMIUM);
const CR_STDERR_LOG = resolve(LOG_DIR, 'chromium-cdp-stderr.log');
const CR_STDOUT_LOG = resolve(LOG_DIR, 'chromium-cdp-stdout.log');

const DEFAULT_CHROMIUM_PORT = 9222;
const DEFAULT_CHROMIUM_ADDRESS = '127.0.0.1';
// Persistent by default (NOT /tmp — that would lose X login on restart).
const DEFAULT_CHROMIUM_PROFILE_DIR = resolve(
  homedir(),
  'Library/Application Support/disclaude/chromium-cdp'
);

/**
 * Resolve the CDP port for the chromium-cdp service (Issue #4807).
 *
 * Reads CHROMIUM_CDP_PORT (env or .env); valid range 1-65535, same bounds as
 * resolveApiPort. Defaults to 9222 — the value BU_CDP_URL / Docker CDP_PORT
 * already assume.
 *
 * @returns {number} port
 */
export function resolveChromiumPort() {
  const raw = process.env.CHROMIUM_CDP_PORT;
  if (raw) {
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port >= 1 && port <= 65535) return port;
    console.warn(
      `Warning: invalid CHROMIUM_CDP_PORT "${raw}", using default ${DEFAULT_CHROMIUM_PORT}`
    );
  }
  return DEFAULT_CHROMIUM_PORT;
}

/**
 * Resolve the CDP bind address (Issue #4807).
 *
 * MUST default to an IPv4 loopback (127.0.0.1) — the drift between an IPv6
 * `[::1]` and IPv4 `127.0.0.1` CDP endpoint caused spurious
 * "connection refused" -> misreported as "not logged in" in the X daily
 * digest. Binding explicitly to one predictable address avoids that.
 *
 * Overflow from keeping IPv6: Chrome sometimes also binds [::1]; consumers
 * must use the single advertised address (see BU_CDP_URL in the plist).
 *
 * @returns {string} address
 */
export function resolveChromiumAddress() {
  return process.env.CHROMIUM_CDP_ADDRESS || DEFAULT_CHROMIUM_ADDRESS;
}

/**
 * Resolve the persistent Chrome profile (user-data-dir) location (Issue
 * #4807, "profile 保存位置可通过环境变量/.env 控制").
 *
 * Reads CHROMIUM_CDP_PROFILE_DIR (env or .env). Defaulting to a persistent
 * `~/Library/Application Support/disclaude/chromium-cdp` keeps X / other
 * login cookies across service restarts — the whole point of hosting via
 * launchd (a /tmp user-data-dir would drop them).
 *
 * @returns {string} absolute profile directory
 */
export function resolveChromiumProfileDir() {
  return process.env.CHROMIUM_CDP_PROFILE_DIR || DEFAULT_CHROMIUM_PROFILE_DIR;
}

/**
 * Whether the chromium-cdp service runs headed or headless.
 *
 * Defaults to headless (matches start-chromium-cdp.sh). Set CHROMIUM_CDP_HEADED=1
 * to run a visible window (useful to confirm login state on a desktop).
 *
 * @returns {boolean} true when headless (the default)
 */
export function resolveChromiumHeadless() {
  const v = (process.env.CHROMIUM_CDP_HEADED || '').toLowerCase();
  return !(v === '1' || v === 'true' || v === 'yes');
}

/**
 * Locate the Chrome/Chromium binary for the chromium-cdp service.
 *
 * Priority: CHROMIUM_CDP_BINARY (env/.env) -> common macOS app paths ->
 * `google-chrome`/`chromium` on PATH -> Playwright's bundled Chromium
 * (mirrors find_chrome_binary in scripts/start-chromium-cdp.sh).
 *
 * @returns {string | null} resolved binary path, or null if none found
 */
export function resolveChromiumBinary() {
  const fromEnv = process.env.CHROMIUM_CDP_BINARY;
  if (fromEnv) {
    try {
      accessSync(fromEnv, constants.X_OK);
      if (statSync(fromEnv).isFile()) return fromEnv;
    } catch { /* Diagnose the configured path without falling back. */ }
    console.warn('Configured CHROMIUM_CDP_BINARY was not found or is not executable; select a valid executable.');
    return null; // Never silently switch to the operator's daily browser.
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ];
  for (const c of candidates) {
    // PATH lookups: resolve via which so the returned value is absolute.
    if (!c.includes('/')) {
      try {
        const p = execSync(`which ${c}`, { encoding: 'utf-8' }).trim();
        if (p && existsSync(p)) return p;
      } catch {
        /* not on PATH */
      }
    } else if (existsSync(c)) {
      return c;
    }
  }
  // Playwright-bundled Chromium fallback.
  try {
    const p = execSync('npx playwright exec which chromium', { encoding: 'utf-8' }).trim();
    if (p && existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Build the Chrome CLI arguments for the chromium-cdp launchd service.
 *
 * --remote-debugging-address defaults to 127.0.0.1 (IPv4) to fix the
 * IPv4<->IPv6 endpoint drift; --user-data-dir is the persistent profile.
 * Other flags mirror start-chromium-cdp.sh where they make sense on macOS
 * (no --no-sandbox/--disable-gpu needed for a host user-run Chrome).
 *
 * @returns {string[]} Chrome argument vector
 */
export function buildChromiumArguments() {
  const port = resolveChromiumPort();
  const address = resolveChromiumAddress();
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${address}`,
    `--user-data-dir=${resolveChromiumProfileDir()}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    'about:blank',
  ];
  if (resolveChromiumHeadless()) {
    args.push('--headless=new');
  } else {
    // Match the manual `--start-maximized` invocation (Issue #4807) so the
    // headed service window + visible profile behave identically.
    args.push('--start-maximized');
  }
  return args;
}

/**
 * Diagnose a CDP port conflict before generating the plist (Issue #4807: "占用
 * 冲突时给出明确诊断，而非静默失败"). Keeps the manual
 * start-chromium-cdp.sh check_port spirit but never hard-fails — launchd's
 * KeepAlive needs the port free, so we warn loudly with the offending PID/cmd.
 *
 * @param {number} port
 * @returns {boolean} true when the port appears in use
 */
export function checkPortInUse(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0;
  } catch {
    return false; // lsof exits 1 when nothing listens — good
  }
}

/**
 * Generate the chromium-cdp plist file.
 */
function generateChromiumPlist() {
  const chromeBin = resolveChromiumBinary();
  if (!chromeBin) {
    console.error('Error: Chrome/Chromium binary not found.');
    console.error('Install Chrome, or set CHROMIUM_CDP_BINARY to its path (e.g. in .env).');
    throw new Error('Selected browser is unavailable');
  }
  const port = resolveChromiumPort();
  const address = resolveChromiumAddress();
  const profileDir = resolveChromiumProfileDir();
  const headless = resolveChromiumHeadless();
  const caffeinatePath = getCaffeinatePath();
  const chromeArgs = buildChromiumArguments();

  // ProgramArguments: wrap with caffeinate -s (same as the service) so the
  // machine doesn't sleep and drop the overnight CDP endpoint; KeepAlive
  // relaunches the whole chain on crash.
  const programArgs = caffeinatePath
    ? [caffeinatePath, '-s', chromeBin, ...chromeArgs]
    : [chromeBin, ...chromeArgs];

  const buildCdpUrl = `http://${address}:${port}`;

  if (checkPortInUse(port)) {
    console.warn(`Warning: port ${port} is already in use.`);
    try {
      execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: 'inherit' });
    } catch {
      /* ignore */
    }
    console.warn(
      `  A conflicting process holds ${address}:${port}. Stop it (e.g. a manually-started Chrome) before loading the service, else KeepAlive will fight over the port.`
    );
  }

  mkdirSync(profileDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_CHROMIUM}</string>

  <key>ProgramArguments</key>
  <array>
${programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardErrorPath</key>
  <string>${CR_STDERR_LOG}</string>

  <key>StandardOutPath</key>
  <string>${CR_STDOUT_LOG}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH ?? '')}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>BU_CDP_URL</key>
    <string>${buildCdpUrl}</string>
    <key>CHROMIUM_CDP_PROFILE_DIR</key>
    <string>${xmlEscape(profileDir)}</string>
    <key>CHROMIUM_CDP_PORT</key>
    <string>${String(port)}</string>
    <key>CHROMIUM_CDP_ADDRESS</key>
    <string>${xmlEscape(address)}</string>
  </dict>
</dict>
</plist>
`;

  ensureLaunchAgentsDir();
  ensureLogDir();
  // Save the resolved selection (not the entire environment) outside the package.
  // A write failure occurs before replacing the plist or unloading the service.
  saveChromiumConfig({
    CHROMIUM_CDP_BINARY: chromeBin,
    CHROMIUM_CDP_PROFILE_DIR: profileDir,
    CHROMIUM_CDP_PORT: String(port),
    CHROMIUM_CDP_ADDRESS: address,
    CHROMIUM_CDP_HEADED: headless ? '0' : '1',
  });
  replaceChromiumFile(CR_PLIST_PATH, Buffer.from(plist));
  console.log(`Plist generated: ${CR_PLIST_PATH}`);
  console.log(`  Chrome: ${chromeBin}`);
  console.log(`  CDP endpoint: ${buildCdpUrl} (BU_CDP_URL injected for browser-use skill)`);
  console.log(`  Profile (persistent): ${profileDir}`);
  console.log(
    `  Mode: ${headless ? 'headless' : 'headed'} (CHROMIUM_CDP_HEADED=1 for a visible window)`
  );
  console.log(
    `  Caffeinate: ${caffeinatePath ? `enabled (${caffeinatePath} -s)` : 'not available'}`
  );
  console.log(`  KeepAlive: auto-relaunch on crash; RunAtLoad on boot`);
  console.log(`  Stdout: ${CR_STDOUT_LOG}`);
  console.log(`  Stderr: ${CR_STDERR_LOG}`);
  console.log(
    `  Note: an already-loaded service must be reloaded (npm run launchd:chromium:restart) to pick up the new plist.`
  );
}

function loadPlistAt(plistPath, label) {
  if (!existsSync(plistPath)) {
    console.error(`Plist not found: ${plistPath}`);
    console.error('Run "generate" or "install" first.');
    throw new Error('Cannot load missing plist');
  }
  execFileSync('launchctl', ['load', plistPath], { stdio: 'inherit' });
  console.log(`Service loaded (${label}).`);
}

function unloadPlistAt(plistPath, label) {
  if (!existsSync(plistPath)) return;
  try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' }); }
  catch { /* Preserve idempotent stop/restart when the service is already unloaded. */ }
  console.log(`Service unloaded (${label}).`);
}

function chromiumServicePid() {
  try {
    const output = execFileSync('launchctl', ['list', LABEL_CHROMIUM], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { loaded: true, pid: Number(output.match(/"PID"\s*=\s*(\d+)/)?.[1]) || undefined };
  } catch { return { loaded: false }; }
}

function validateIsolatedChromium() {
  const root = resolve(process.env.DISCLAUDE_LAUNCHD_STATE_DIR);
  const actualRoot = realpathSync(root);
  for (const path of [chromiumConfigPath(), resolveChromiumProfileDir()]) {
    const part = relative(root, resolve(path));
    if (!part || part === '..' || part.startsWith('../') || isAbsolute(part)) throw new Error('Isolated Chromium config/profile must be inside its test state directory');
    // Existing ancestors must not redirect the test into a daily profile.
    let ancestor = resolve(path);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const actual = relative(actualRoot, realpathSync(ancestor));
    if (actual === '..' || actual.startsWith('../') || isAbsolute(actual)) throw new Error('Isolated Chromium path escapes through a symlink');
  }
  if (resolveChromiumAddress() !== '127.0.0.1' || !process.env.CHROMIUM_CDP_PORT) throw new Error('Isolated Chromium requires an explicit loopback port');
}

async function activateChromium(restart) {
  if (process.platform !== 'darwin') throw new Error('Chromium launchd commands require macOS; no service was changed');
  const config = chromiumConfigPath();
  const prior = chromiumServicePid();
  if (prior.loaded && !restart) throw new Error('Chromium service is already loaded; use restart to change its configuration');
  if (prior.loaded && !existsSync(CR_PLIST_PATH)) throw new Error('Loaded service has no saved plist; cannot provide rollback');
  const selected = { address: resolveChromiumAddress(), port: resolveChromiumPort() };
  let previous;
  if (prior.loaded) {
    const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', CR_PLIST_PATH], { encoding: 'utf8' }));
    const environment = plist.EnvironmentVariables;
    previous = { address: environment.CHROMIUM_CDP_ADDRESS, port: Number(environment.CHROMIUM_CDP_PORT) };
    if (!previous.address || !Number.isSafeInteger(previous.port) || previous.port < 1 || previous.port > 65535) throw new Error('Previous plist has no usable CDP configuration for rollback');
  }
  const conflicts = chromiumListenerPids(selected.port).filter(pid => !prior.pid || !isDescendant(pid, prior.pid));
  if (conflicts.length) throw new Error(`CDP port ${selected.port} is held by another process; existing service preserved`);
  const binary = resolveChromiumBinary();
  if (!binary) throw new Error('Selected browser is unavailable; existing service preserved');
  // The candidate uses disposable state before any persistent configuration changes.
  const probe = await promisify(execFile)(process.execPath, [resolve(PROJECT_ROOT, 'bin/disclaude.js'), 'browser', 'doctor', '--binary', binary,
    ...(resolveChromiumHeadless() ? ['--headless'] : [])], { timeout: 90_000, maxBuffer: 1024 * 1024 });
  const diagnosis = JSON.parse(probe.stdout);
  if (!diagnosis.usable) throw new Error('Selected browser failed its temporary-profile preflight');
  const stop = async () => {
    if (!chromiumServicePid().loaded) return;
    execFileSync('launchctl', ['unload', CR_PLIST_PATH], { stdio: 'pipe' });
    if (chromiumServicePid().loaded) throw new Error('launchd service remained loaded after stop');
  };
  const ready = await transitionChromium({ paths: [config, CR_PLIST_PATH], wasLoaded: prior.loaded,
    prepare: () => generateChromiumPlist(), stop,
    start: () => loadPlistAt(CR_PLIST_PATH, LABEL_CHROMIUM),
    verify: () => waitChromiumReady(selected, chromiumServicePid), verifyPrevious: () => waitChromiumReady(previous, chromiumServicePid) });
  console.log(`CDP ready: ${ready.endpoint} (${ready.browser}, service PID ${ready.pid})`);
  console.log(`Temporary-profile cookie persistence: ${diagnosis.cookiePersistence}; service-profile persistence was not tested by this command.`);
}

async function withChromiumActivationLock(action) {
  const lock = `${CR_PLIST_PATH}.activation.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another activation owns ${lock}; check its recorded PID before removing a stale lock`); throw error; }
  try {
    return await action();
  } finally { rmSync(lock, { force: true }); }
}

// ---- chromium-cdp commands ----------------------------------------------

function cmdChromiumGenerate() {
  generateChromiumPlist();
}

async function cmdChromiumInstall() {
  await activateChromium(false);
  console.log('\nChromium CDP service installed and started.');
}

function cmdChromiumUninstall() {
  unloadPlistAt(CR_PLIST_PATH, LABEL_CHROMIUM);
  if (existsSync(CR_PLIST_PATH)) {
    rmSync(CR_PLIST_PATH);
    console.log(`Plist removed: ${CR_PLIST_PATH}`);
  }
  console.log('Chromium CDP service uninstalled.');
}

async function cmdChromiumStart() {
  await activateChromium(false);
  console.log('\nChromium CDP service started.');
}

function cmdChromiumStop() {
  unloadPlistAt(CR_PLIST_PATH, LABEL_CHROMIUM);
}

async function cmdChromiumRestart() {
  await activateChromium(true);
  console.log('\nChromium CDP service restarted.');
}

function cmdChromiumLogs() {
  const lines = process.argv.find((a) => a.startsWith('--lines='));
  const n = lines ? lines.split('=')[1] : '100';
  console.log(`=== chromium-cdp stdout (last ${n} lines) ===`);
  try {
    run(`tail -n ${n} ${CR_STDOUT_LOG}`, { silent: true });
  } catch {}
  console.log(`\n=== chromium-cdp stderr (last ${n} lines) ===`);
  try {
    run(`tail -n ${n} ${CR_STDERR_LOG}`, { silent: true });
  } catch {}
}

function cmdChromiumStatus() {
  const result = run(`launchctl list | grep ${LABEL_CHROMIUM}`, { allowFail: true, silent: true });
  if (result) {
    console.log(result.trim());
    console.log(`\nPlist: ${CR_PLIST_PATH}`);
    console.log(`Configured profile (may differ from loaded service): ${resolveChromiumProfileDir()}`);
    console.log(`Configuration: ${chromiumConfigPath()}`);
    console.log(`Stdout: ${CR_STDOUT_LOG}`);
    console.log(`Stderr: ${CR_STDERR_LOG}`);
  } else {
    console.log('Chromium CDP service is NOT loaded.');
    console.log(`Plist: ${CR_PLIST_PATH} (${existsSync(CR_PLIST_PATH) ? 'exists' : 'not found'})`);
  }
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
  execFileSync('launchctl', ['load', PLIST_PATH], { stdio: 'inherit' });
  console.log('Service loaded.');
}

function unloadPlist() {
  if (!existsSync(PLIST_PATH)) {
    return; // Nothing to unload
  }
  execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' });
  console.log('Service unloaded.');
}

function build() {
  // Tagged installations already contain compiled modules and no build tools.
  if (existsSync(resolve(PROJECT_ROOT, 'release-source.json'))) return;
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
  const lines = process.argv.find((a) => a.startsWith('--lines='));
  const n = lines ? lines.split('=')[1] : '100';
  console.log(`=== app log (last ${n} lines) ===`);
  try {
    run(`tail -n ${n} ${resolveAppLog()}`, { silent: true });
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
    console.log(`App log: ${resolveAppLog()} (use newsyslog for rotation)`);
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

// Issue #4807: an optional first service selector. The default path (`launchd.mjs
// <command>`) keeps the service service; `launchd.mjs chromium-cdp <command>`
// (alias `chromium`) manages the headless-Chromium CDP service. This is how
// `disclaude chromium-cdp ...` routes in (bin/disclaude.js prepends the selector).
const FIRST_ARG = process.argv[2];
const IS_CHROMIUM = FIRST_ARG === 'chromium' || FIRST_ARG === 'chromium-cdp' || FIRST_ARG === 'chromium-isolated';
const IS_ISOLATED = FIRST_ARG === 'isolated';
const command = IS_CHROMIUM || IS_ISOLATED ? process.argv[3] : FIRST_ARG;

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

const chromiumCommands = {
  generate: cmdChromiumGenerate,
  install: cmdChromiumInstall,
  uninstall: cmdChromiumUninstall,
  start: cmdChromiumStart,
  stop: cmdChromiumStop,
  restart: cmdChromiumRestart,
  logs: cmdChromiumLogs,
  status: cmdChromiumStatus,
};

// Issue #4576: entry guard so
// the pure helpers (resolveApiPort, buildProgramArguments, ...) can be imported
// by tests without triggering command dispatch. Compared via realpath so a
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
  const table = IS_CHROMIUM ? chromiumCommands : commands;

  if (!command || !table[command]) {
    if (IS_CHROMIUM) {
      console.log(`Usage: node scripts/launchd.mjs chromium-cdp <command>

Manages the com.disclaude.chromium-cdp service (persistent Chromium CDP
endpoint for browser-use / X daily digest; see Issue #4807).

Commands:
  generate    Generate plist file
  install     Generate + load (first-time setup)
  uninstall   Unload + remove plist
  start       Generate + load
  stop        Unload (keep plist)
  restart     Generate + unload + load (preserves saved selection)
  logs        Tail log files [--lines=N]
  status      Show service status
`);
      process.exit(1);
    }
    console.log(`Usage: node scripts/launchd.mjs <command>
       node scripts/launchd.mjs isolated <command>

Commands:
  generate    Generate plist file
  install     Generate + load (first-time setup)
  uninstall   Unload + remove plist
  start       Build + load
  stop        Unload (keep plist)
  restart     Build + unload + load
  logs        Tail log files [--lines=N]
  status      Show service status

The isolated form requires the isolation flag, a test-only label, and an
absolute state directory. Missing settings fail closed before launchctl runs.
`);
    process.exit(1);
  }

  // Explicit environment > persistent user configuration > legacy package .env.
  // stop/uninstall/logs must remain usable even when configuration is corrupt.
  if (IS_CHROMIUM && ['generate', 'install', 'start', 'restart', 'status'].includes(command)) {
    loadChromiumConfig();
  }
  if (FIRST_ARG === 'chromium-isolated') validateIsolatedChromium();
  else loadDotEnv(resolve(PROJECT_ROOT, '.env'));
  try {
    if (IS_CHROMIUM && !['status', 'logs'].includes(command)) await withChromiumActivationLock(table[command]);
    else await table[command]();
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
