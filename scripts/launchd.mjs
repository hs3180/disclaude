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
 *   node scripts/launchd.mjs service <command>   # same, via `disclaude service ...`
 *   node scripts/launchd.mjs chromium-cdp <cmd>  # persistent Chromium CDP service
 *
 * Every application-service command accepts --dry-run (Issue #5619): prints
 * the plist that would be written and the launchctl commands that would run,
 * without touching the filesystem or any service.
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
import { writeFileSync, existsSync, mkdirSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { realpathSync, accessSync, constants, statSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { chromiumConfigPath, loadChromiumConfig, saveChromiumConfig, readChromiumConfig } from './chromium-config.mjs';
import { replaceChromiumFile, transitionChromium, chromiumListenerPids, isDescendant, waitChromiumReady } from './browser-service-state.mjs';
import { describeChromiumSelection } from './chromium-status.mjs';
import { assertChromiumProfileAvailable, assertChromiumProfileVersion } from './chromium-profile.mjs';
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
// deployment started with bare `start` used to have no HTTP API. The server
// binds localhost only (HttpApiServerConfig.host default) and GET routes are
// token-exempt, so this matches the security posture of interactive runs.
// Override with DISCLAUDE_LAUNCHD_API_PORT / DISCLAUDE_LAUNCHD_API_TOKEN.
//
// Issue #5619: the plist must reproduce the production service, and a
// port-0 default cannot — nobody (operator, MCP tools, monitoring) can
// predict an OS-assigned port, so every regenerated plist diverges from the
// running deployment. The default is therefore the fixed port the #4576
// rollout used (19200); `launchd.apiPort` in the disclaude config or
// DISCLAUDE_LAUNCHD_API_PORT=0 restores an OS-assigned port explicitly.
const DEFAULT_API_PORT = 19200;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Read the launchd deployment settings from the `.disclaude` configuration
 * (Issue #5619): the generated plist must take its entry path, API port and
 * extra environment variables from the operator's config instead of pointing
 * at the package checkout with a port-0 default.
 *
 * Search order mirrors packages/core/src/config/discovery.ts: an explicit
 * DISCLAUDE_LAUNCHD_CONFIG_PATH (isolated tests) or DISCLAUDE_CONFIG_PATH,
 * then `<home>/.disclaude/disclaude.config.{yaml,yml}`, then the working
 * directory. Recognized keys (all optional, safe defaults otherwise):
 *
 *   launchd:
 *     entry: /absolute/path/to/bin/disclaude.js   # service entry executable
 *     apiPort: 19200                              # HTTP API port (not 0)
 *     apiToken: $SECRET                           # --api-token value
 *     env: { KEY: value }   # extra plist env, merged over the top-level env: block
 *   env: { KEY: value }     # runtime env block — also mirrored into the plist
 *
 * The return value always carries human-readable `sources` so `generate`
 * (and its dry-run) can state where every value came from.
 *
 * @param {NodeJS.ProcessEnv} env - environment to read override paths from
 * @param {string} home - home directory for the `.disclaude` lookup
 * @param {string} cwd - working directory for the project-root lookup
 * @returns {{configPath: string | null, entry: string | undefined,
 *   apiPort: number | undefined, apiToken: string | undefined,
 *   env: Record<string, string>, sources: string[]}}
 */
export function readLaunchdDeploymentConfig(env = process.env, home = homedir(), cwd = process.cwd()) {
  const sources = [];
  const candidates = [];
  const isolatedOnly = Boolean(env.DISCLAUDE_LAUNCHD_CONFIG_PATH);
  if (isolatedOnly) {
    // Isolated rehearsal: never fall through to the operator's real config.
    candidates.push(env.DISCLAUDE_LAUNCHD_CONFIG_PATH);
  } else {
    if (env.DISCLAUDE_CONFIG_PATH) candidates.push(env.DISCLAUDE_CONFIG_PATH);
    if (home) {
      for (const name of ['disclaude.config.yaml', 'disclaude.config.yml']) {
        candidates.push(resolve(home, '.disclaude', name));
      }
    }
    for (const name of ['disclaude.config.yaml', 'disclaude.config.yml']) {
      candidates.push(resolve(cwd, name));
    }
  }
  let configPath = null;
  if (isolatedOnly) {
    // Keep the historical isolated contract: the override is passed through
    // whether or not the file exists yet.
    configPath = env.DISCLAUDE_LAUNCHD_CONFIG_PATH;
    if (!existsSync(configPath)) {
      sources.push(`warning: isolated config ${configPath} does not exist; entry/port/env use built-in defaults`);
    }
  } else {
    configPath = candidates.find((p) => existsSync(p)) ?? null;
  }
  const result = { configPath, entry: undefined, apiPort: undefined, apiToken: undefined, env: {}, sources };
  if (!configPath) {
    sources.push('no disclaude config found (looked in $DISCLAUDE_LAUNCHD_CONFIG_PATH, $DISCLAUDE_CONFIG_PATH, ~/.disclaude/, working directory); using built-in defaults');
    return result;
  }
  sources.push(`config: ${configPath}`);
  let config = null;
  try {
    config = loadYaml(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    sources.push(`warning: config is not parseable YAML (${error.message}); using built-in defaults`);
    return result;
  }
  if (!isPlainObject(config)) {
    sources.push('warning: config is not a YAML mapping; using built-in defaults');
    return result;
  }
  const launchd = isPlainObject(config.launchd) ? config.launchd : null;
  if (launchd) {
    if (launchd.entry !== undefined) {
      if (typeof launchd.entry === 'string' && isAbsolute(launchd.entry) && !/[\r\n\0]/.test(launchd.entry)) {
        result.entry = launchd.entry;
      } else {
        sources.push('warning: launchd.entry must be an absolute path without control characters; ignored');
      }
    }
    if (launchd.apiPort !== undefined) {
      const port = Number(launchd.apiPort);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        result.apiPort = port;
      } else {
        sources.push(`warning: launchd.apiPort "${String(launchd.apiPort)}" is not an integer in 1-65535; ignored`);
      }
    }
    if (typeof launchd.apiToken === 'string') result.apiToken = launchd.apiToken;
  }
  // Merge both env blocks (Issue #5619): the top-level `env:` entries the
  // runtime Config would inject, plus `launchd.env` for plist-specific
  // overrides. launchd.env wins on key collisions.
  const mergedEnv = {};
  if (isPlainObject(config.env)) Object.assign(mergedEnv, config.env);
  if (launchd && isPlainObject(launchd.env)) Object.assign(mergedEnv, launchd.env);
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (!ENV_NAME_RE.test(key) || value === undefined || value === null) continue;
    result.env[key] = String(value);
  }
  return result;
}

/**
 * Resolve the --api-port value for the plist (Issues #4576, #5619).
 *
 * Precedence: DISCLAUDE_LAUNCHD_API_PORT (0-65535; 0 explicitly asks the OS
 * for a port) -> `launchd.apiPort` from the disclaude config -> the fixed
 * production default 19200. A fixed default keeps regenerated plists
 * reproducible instead of drifting behind an ephemeral OS-assigned port.
 *
 * @param {{apiPort?: number} | null} deployment - parsed deployment config
 * @returns {number} port for --api-port
 */
export function resolveApiPort(deployment = null) {
  const raw = process.env.DISCLAUDE_LAUNCHD_API_PORT;
  if (raw) {
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port >= 0 && port <= 65535) {
      return port;
    }
    console.warn(
      `Warning: invalid DISCLAUDE_LAUNCHD_API_PORT "${raw}", falling back to config/default ${DEFAULT_API_PORT}`
    );
  }
  if (deployment?.apiPort !== undefined) {
    return deployment.apiPort;
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
// Plist validation + atomic install (Issue #5619, T-038)
// ---------------------------------------------------------------------------

/**
 * Offline structural validation for a generated launchd plist (Issue #5619).
 *
 * The authoritative check on macOS is `plutil -lint`; on non-darwin hosts
 * (Linux CI) plutil does not exist, so this function provides the equivalent
 * contract we can assert offline: a well-formed XML document with balanced
 * tags and the keys a launchd LaunchAgent cannot work without (Label,
 * ProgramArguments, RunAtLoad, KeepAlive). It is intentionally conservative —
 * it only needs to catch a corrupted or half-written plist, not fully
 * implement plist typing.
 *
 * @param {string} xml - plist document text
 * @returns {string | null} null when valid, otherwise a human-readable error
 */
export function validatePlistStructure(xml) {
  if (typeof xml !== 'string' || xml.length === 0) return 'plist is empty';
  if (!xml.startsWith('<?xml')) return 'plist is missing the XML declaration';
  if (!xml.includes('<plist version="1.0">')) return 'plist is missing the <plist> root element';
  // Tag balance: tokenize tags, ignore the declaration/doctype/comments, and
  // treat self-closing tags (<true/>) as balanced by construction.
  const stack = [];
  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;
  let match;
  let sawRootClose = false;
  while ((match = tagRe.exec(xml)) !== null) {
    const [, closing, name, , selfClosing] = match;
    if (selfClosing) continue;
    if (!closing) {
      stack.push(name);
      continue;
    }
    const open = stack.pop();
    if (open !== name) {
      return open === undefined
        ? `unexpected closing tag </${name}>`
        : `mismatched closing tag </${name}> (expected </${open}>)`;
    }
    if (name === 'plist') sawRootClose = true;
  }
  if (stack.length > 0) return `unclosed tag <${stack[stack.length - 1]}>`;
  if (!sawRootClose) return 'plist root element is never closed';
  for (const required of ['Label', 'ProgramArguments', 'RunAtLoad', 'KeepAlive']) {
    if (!xml.includes(`<key>${required}</key>`)) {
      return `plist is missing the required <key>${required}</key> entry`;
    }
  }
  return null;
}

/**
 * Validate a plist file the strongest way the platform allows (Issue #5619).
 *
 * On macOS runs `plutil -lint <path>` — the authoritative check launchd
 * operators rely on. Everywhere else (Linux CI) plutil does not exist, so it
 * falls back to {@link validatePlistStructure} over the file contents and the
 * caller reports which mode ran; real `plutil -lint` behaviour on macOS is
 * verified on-device, not in CI.
 *
 * @param {string} path - plist file to validate
 * @param {NodeJS.ProcessEnv} [env] - environment (test seam for platform)
 * @returns {string | null} null when valid, otherwise a human-readable error
 */
export function lintPlistFile(path, env = process.env) {
  if (env.PLATFORM_OVERRIDE === 'darwin' || process.platform === 'darwin') {
    try {
      execFileSync('plutil', ['-lint', path], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      return null;
    } catch (error) {
      return `plutil -lint rejected ${path}: ${error.message}`;
    }
  }
  let xml;
  try {
    xml = readFileSync(path, 'utf-8');
  } catch (error) {
    return `cannot read plist for validation: ${error.message}`;
  }
  return validatePlistStructure(xml);
}

/**
 * Install a plist atomically: write a uniquely-named temporary file next to
 * the target, validate it, then rename over the target (Issue #5619, T-038).
 *
 * rename(2) is atomic, so a crash or interruption can only ever leave either
 * the previous plist or the complete new one — never a half-written partial
 * file that launchd might pick up on the next load. Re-running with the
 * same content is idempotent (the rename simply replaces the file).
 *
 * @param {string} path - final plist path
 * @param {string | Buffer} bytes - plist document
 * @param {object} [options]
 * @param {number} [options.mode=0o644] - file mode for the plist
 * @param {(path: string) => string | null} [options.lint] - validator invoked
 *   on the temporary file before the rename; returning a message aborts the
 *   install with the previous plist untouched
 * @returns {{ linted: boolean }} whether a lint function ran
 */
export function installPlistAtomically(path, bytes, { mode = 0o644, lint = null } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let linted = false;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode });
    if (lint) {
      linted = true;
      const failure = lint(temporary);
      if (failure) throw new Error(failure);
    }
    renameSync(temporary, path);
  } finally {
    // No-op after a successful rename; removes the temporary on any failure.
    rmSync(temporary, { force: true });
  }
  return { linted };
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
 * Issue #4576: appends --api-port (fixed production default, see
 * resolveApiPort) so the DisclaudeService HTTP API server is up for the
 * REST-only MCP tools; --api-token only when provided via
 * DISCLAUDE_LAUNCHD_API_TOKEN or launchd.apiToken (mirrors the
 * interactive-run posture — GET routes stay token-exempt, write routes gain
 * Bearer auth).
 *
 * Issue #5619: --config now defaults to the discovered disclaude config
 * (from readLaunchdDeploymentConfig) so the plist reproduces exactly the
 * configuration the production service runs, instead of relying on the
 * checkout WorkingDirectory for config discovery. The isolated test
 * override (DISCLAUDE_LAUNCHD_CONFIG_PATH) keeps priority.
 *
 * @param {string} cliPath - Absolute path to the unified executable
 * @param {string | null} caffeinatePath - caffeinate binary or null
 * @param {{configPath: string | null, apiToken?: string} | null} deployment -
 *   parsed deployment config (config/apiToken sources)
 * @returns {string[]} ProgramArguments entries
 */
export function buildProgramArguments(cliPath = CLI_ENTRY, caffeinatePath = getCaffeinatePath(), deployment = null) {
  const args = [];

  if (caffeinatePath) {
    args.push(caffeinatePath, '-s');
  }

  args.push(cliPath, 'start', '--api-port', String(resolveApiPort(deployment)));

  const configPath = process.env.DISCLAUDE_LAUNCHD_CONFIG_PATH
    ?? deployment?.configPath
    ?? undefined;
  if (configPath) {
    args.push('--config', configPath);
  }

  const apiToken = process.env.DISCLAUDE_LAUNCHD_API_TOKEN ?? deployment?.apiToken;
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

/**
 * Environment keys the plist itself owns (Issue #5619). Values from the
 * config's `env:` block cannot override them — those describe service
 * runtime, not how launchd runs the process.
 */
const PLIST_RESERVED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'NODE_ENV',
  'LOG_TO_FILE',
  'LOG_DIR',
  'DISCLAUDE_API_BASE_URL',
  'LOCKFILE_PATH',
]);

/**
 * Render the application-service plist XML (Issue #5619).
 *
 * Pure function: builds the exact string `generate` writes (or prints in
 * dry-run) without touching the filesystem, so tests can assert the
 * production-relevant fields — entry path, fixed API port, environment —
 * offline.
 *
 * @param {object} options
 * @param {string} options.label - launchd label
 * @param {string[]} options.programArgs - ProgramArguments entries
 * @param {string} options.workingDirectory - WorkingDirectory
 * @param {string} options.stdoutLog - StandardOutPath
 * @param {string} options.stderrLog - StandardErrorPath
 * @param {string} options.logDir - LOG_DIR env value
 * @param {string} options.home - HOME env value
 * @param {string} options.pathEnv - PATH env value
 * @param {string | null} options.restChannelApiBaseUrl - DISCLAUDE_API_BASE_URL
 * @param {Record<string, string>} options.extraEnv - config `env:` entries
 * @param {string} [options.lockfilePath] - isolated-only LOCKFILE_PATH
 * @returns {string} plist document
 */
export function buildServicePlist({
  label,
  programArgs,
  workingDirectory,
  stdoutLog,
  stderrLog,
  logDir,
  home,
  pathEnv,
  restChannelApiBaseUrl,
  extraEnv = {},
  lockfilePath,
}) {
  const extraEnvLines = Object.keys(extraEnv)
    .filter((key) => {
      if (PLIST_RESERVED_ENV_KEYS.has(key)) {
        console.warn(`Warning: config env key "${key}" is reserved by the launchd plist; skipped`);
        return false;
      }
      return true;
    })
    .sort()
    .map((key) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(extraEnv[key])}</string>\n`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>

  <key>ProgramArguments</key>
  <array>
${programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>

  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDirectory)}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrLog)}</string>

  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutLog)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
${restChannelApiBaseUrl ? `    <key>DISCLAUDE_API_BASE_URL</key>\n    <string>${xmlEscape(restChannelApiBaseUrl)}</string>\n` : ''}    <key>HOME</key>
    <string>${xmlEscape(home)}</string>
${lockfilePath ? `    <key>LOCKFILE_PATH</key>\n    <string>${xmlEscape(lockfilePath)}</string>\n` : ''}${extraEnvLines}    <key>NODE_ENV</key>
    <string>production</string>
    <key>LOG_TO_FILE</key>
    <string>true</string>
    <key>LOG_DIR</key>
    <string>${xmlEscape(logDir)}</string>
  </dict>
</dict>
</plist>
`;
}

/**
 * Resolve the service entry executable for the plist (Issue #5619).
 *
 * Precedence: the isolated test override (DISCLAUDE_LAUNCHD_ENTRY) ->
 * `launchd.entry` from the disclaude config -> the package checkout default.
 * The returned `source` feeds the generate/dry-run output so operators can
 * see where the entry came from instead of silently pinning the checkout.
 *
 * @param {{entry?: string} | null} deployment - parsed deployment config
 * @returns {{entry: string, source: string}}
 */
export function resolveServiceEntry(deployment = null) {
  if (process.argv[2] === 'isolated' && process.env.DISCLAUDE_LAUNCHD_ENTRY) {
    return { entry: process.env.DISCLAUDE_LAUNCHD_ENTRY, source: 'DISCLAUDE_LAUNCHD_ENTRY (isolated override)' };
  }
  if (deployment?.entry) {
    return { entry: deployment.entry, source: 'launchd.entry from the disclaude config' };
  }
  return { entry: CLI_ENTRY, source: 'package checkout default (bin/disclaude.js); set launchd.entry in the disclaude config to pin the production entry' };
}

function generatePlist({ dryRun = false } = {}) {
  assertServiceMigrationComplete(LAUNCHAGENTS_DIR);
  const nodePath = getNodePath();
  const caffeinatePath = getCaffeinatePath();
  // Issue #5619: entry/port/env come from the .disclaude config so the
  // regenerated plist reproduces the production service.
  const deployment = readLaunchdDeploymentConfig();
  const { entry, source } = resolveServiceEntry(deployment);
  const programArgs = buildProgramArguments(entry, caffeinatePath, deployment);
  const apiPort = resolveApiPort(deployment);
  const restChannelApiBaseUrl = resolveRestChannelApiBaseUrl(apiPort);

  // Issue #2934: Application logs go through pino file transport
  // (triggered by LOG_TO_FILE env var). Issue #3416: pino-roll removed,
  // rotation delegated to system-level tools (newsyslog / logrotate).
  // Issue #3360: Added StandardOutPath as fallback — when pino file logging
  // fails, console.log/stdout output is still captured.
  // StandardErrorPath is kept for uncaught Node.js crash diagnostics.
  const plist = buildServicePlist({
    label: LABEL,
    programArgs,
    workingDirectory: PROJECT_ROOT,
    stdoutLog: STDOUT_LOG,
    stderrLog: STDERR_LOG,
    logDir: LOG_DIR,
    home: homedir(),
    pathEnv: process.env.PATH ?? '',
    restChannelApiBaseUrl,
    extraEnv: deployment.env,
    lockfilePath: process.argv[2] === 'isolated' ? resolve(LAUNCHAGENTS_DIR, 'disclaude.pid') : undefined,
  });

  if (dryRun) {
    console.log('[dry-run] plist target (NOT written):', PLIST_PATH);
    console.log('[dry-run] config sources:');
    for (const line of deployment.sources) console.log('[dry-run]  -', line);
    console.log('[dry-run] entry:', entry, `(${source})`);
    console.log('[dry-run] api port:', apiPort);
    console.log('[dry-run] --- plist content ---');
    console.log(plist);
    console.log('[dry-run] --- end plist ---');
    console.log('[dry-run] no files written; no launchctl commands executed');
    return;
  }

  ensureLaunchAgentsDir();
  ensureLogDir();
  // Issue #5619 (T-038): lint the fully-written temporary file, then rename it
  // over the target — an interrupted or invalid generate can never leave a
  // half-written plist behind for launchd to load.
  const onDarwin = process.platform === 'darwin';
  installPlistAtomically(PLIST_PATH, plist, {
    mode: 0o644,
    lint: (temp) => lintPlistFile(temp),
  });
  console.log(`Plist generated atomically: ${PLIST_PATH}`);
  console.log(
    `  Validated: ${onDarwin ? 'plutil -lint' : 'structural XML validation (plutil is macOS-only; real plutil -lint is verified on macOS, not in CI)'}`
  );
  console.log(`  Node: ${nodePath}`);
  console.log(`  Entry: ${entry} (${source})`);
  for (const line of deployment.sources) console.log(`  ${line}`);
  console.log(
    `  Caffeinate: ${caffeinatePath ? `enabled (${caffeinatePath} -s)` : 'not available'}`
  );
  console.log(`  API server: --api-port ${apiPort} (REST API for MCP tools; Issues #4576/#5619)`);
  console.log(
    `  REST API base URL env: ${restChannelApiBaseUrl ? `${restChannelApiBaseUrl} (fixed override)` : 'set after dynamic HTTP listen readiness'}`
  );
  console.log(
    `  API token: ${process.env.DISCLAUDE_LAUNCHD_API_TOKEN || deployment.apiToken ? 'enabled (--api-token)' : 'not set (GET-only routes are token-exempt)'}`
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
    throw new Error(`Retire the legacy launchd service before installing this one: ${legacy}. Preserve the existing configuration and workspace.`);
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
const CR_AUTO_PLIST_PATH = resolve(LAUNCHAGENTS_DIR, PLIST_FILENAME_CHROMIUM);
const CR_MANUAL_PLIST_PATH = resolve(process.argv[2] === 'chromium-isolated'
  ? resolve(LAUNCHAGENTS_DIR, '..', 'ManualServices')
  : resolve(homedir(), 'Library/Application Support/disclaude/services'), PLIST_FILENAME_CHROMIUM);
let CR_PLIST_PATH = CR_AUTO_PLIST_PATH;
let CR_PREVIOUS_PLIST_PATH = CR_AUTO_PLIST_PATH;

function selectChromiumPlistPath() {
  const existing = [CR_AUTO_PLIST_PATH, CR_MANUAL_PLIST_PATH].filter(path => existsSync(path));
  if (existing.length > 1) throw new Error('Both automatic and manual Chromium definitions exist; resolve the duplicate before changing services');
  const changing = ['generate', 'install', 'start', 'restart'].includes(command);
  const autostart = changing ? process.env.CHROMIUM_CDP_AUTOSTART : undefined;
  if (autostart && !['0', '1'].includes(autostart)) throw new Error('CHROMIUM_CDP_AUTOSTART must be 0 or 1');
  CR_PREVIOUS_PLIST_PATH = existing[0] || CR_AUTO_PLIST_PATH;
  CR_PLIST_PATH = autostart === undefined && existing.length ? existing[0]
    : autostart === '0' ? CR_MANUAL_PLIST_PATH : CR_AUTO_PLIST_PATH;
  if (command === 'generate' && existing.length && CR_PLIST_PATH !== CR_PREVIOUS_PLIST_PATH) throw new Error('Use install or restart to change autostart with verified recovery');
}
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
 * must use the single advertised address recorded in the Chromium config.
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
  const profileDir = process.env.CHROMIUM_CDP_PROFILE_DIR || DEFAULT_CHROMIUM_PROFILE_DIR;
  if (!isAbsolute(profileDir) || /[\r\n\0]/.test(profileDir)) {
    throw new Error('CHROMIUM_CDP_PROFILE_DIR must be an absolute path without control characters');
  }
  return profileDir;
}

/**
 * Whether the chromium-cdp service runs headed or headless.
 *
 * Defaults to headless. Set CHROMIUM_CDP_HEADED=1
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
 * The selected executable is resolved through the managed Chromium configuration.
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
 * Other flags are selected by the managed browser service where they make sense
 * on macOS
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
 * port check is advisory but never hard-fails — launchd's
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
    CHROMIUM_CDP_AUTOSTART: CR_PLIST_PATH === CR_AUTO_PLIST_PATH ? '1' : '0',
  });
  replaceChromiumFile(CR_PLIST_PATH, Buffer.from(plist));
  console.log(`Plist generated: ${CR_PLIST_PATH}`);
  console.log(`  Chrome: ${chromeBin}`);
  console.log(`  CDP endpoint: ${buildCdpUrl} (saved to the installed Chromium config)`);
  console.log(`  Profile (persistent): ${profileDir}`);
  console.log(
    `  Mode: ${headless ? 'headless' : 'headed'} (CHROMIUM_CDP_HEADED=1 for a visible window)`
  );
  console.log(
    `  Caffeinate: ${caffeinatePath ? `enabled (${caffeinatePath} -s)` : 'not available'}`
  );
  console.log(`  Crash recovery: enabled; login autostart: ${CR_PLIST_PATH === CR_AUTO_PLIST_PATH ? 'enabled' : 'disabled (manual service definition)'}`);
  console.log(`  Stdout: ${CR_STDOUT_LOG}`);
  console.log(`  Stderr: ${CR_STDERR_LOG}`);
  console.log(
    `  Note: an already-loaded service must be reloaded (npm run launchd:chromium:restart) to pick up the new plist.`
  );
}

// Issue #5619 (T-038 rework 2): the Chromium sidecar uses the same modern
// domain-target API as the service side — `bootstrap gui/<uid> <plist>` to
// load, `bootout gui/<uid>/<label>` to unload (idempotent via a `print`
// probe), `print` instead of the legacy `list` for state/pid.
function loadPlistAt(plistPath, label) {
  if (!existsSync(plistPath)) {
    console.error(`Plist not found: ${plistPath}`);
    console.error('Run "generate" or "install" first.');
    throw new Error('Cannot load missing plist');
  }
  try {
    execFileSync('launchctl', buildLaunchctlInvocation('bootstrap', { plistPath, label }), { stdio: 'inherit' });
  } catch (error) {
    // Idempotent load: bootstrap fails when the label is already in the
    // domain. Confirm via print, then bootout + bootstrap so the fresh plist
    // takes effect; anything else is a real failure. (Same recovery as the
    // service-side loadPlist.)
    if (!printChromiumState().loaded) throw error;
    console.log('Chromium service already bootstrapped; reloading with the new plist.');
    execFileSync('launchctl', buildLaunchctlInvocation('bootout', { label }), { stdio: 'pipe' });
    execFileSync('launchctl', buildLaunchctlInvocation('bootstrap', { plistPath, label }), { stdio: 'inherit' });
  }
  console.log(`Service loaded (${label}).`);
}

function unloadPlistAt(label) {
  // bootout addresses the service by domain target, so it works even when the
  // plist file has already been removed; not-loaded is a no-op (stop and
  // uninstall stay idempotent).
  if (!printChromiumState().loaded) return;
  execFileSync('launchctl', buildLaunchctlInvocation('bootout', { label }), { stdio: 'pipe' });
  console.log(`Service unloaded (${label}).`);
}

/**
 * Whether the Chromium sidecar is bootstrapped into the user domain, via
 * `launchctl print gui/<uid>/<label>` (the modern replacement for
 * `launchctl list <label>`). Returns the captured print output so callers can
 * read `pid =` / `state =` lines from the same probe.
 */
function printChromiumState() {
  try {
    const output = execFileSync('launchctl', buildLaunchctlInvocation('print', { label: LABEL_CHROMIUM }), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { loaded: true, output };
  } catch {
    return { loaded: false, output: '' };
  }
}

function chromiumServicePid() {
  const { loaded, output } = printChromiumState();
  return { loaded, pid: loaded ? (Number(output.match(/^\s*pid\s*=\s*(\d+)/m)?.[1]) || undefined) : undefined };
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
  const binary = resolveChromiumBinary();
  if (!binary) throw new Error('Selected browser is unavailable; existing service preserved');
  const config = chromiumConfigPath();
  const prior = chromiumServicePid();
  if (prior.loaded && !restart) throw new Error('Chromium service is already loaded; use restart to change its configuration');
  if (prior.loaded && !existsSync(CR_PREVIOUS_PLIST_PATH)) throw new Error('Loaded service has no saved plist; cannot provide rollback');
  const selected = { address: resolveChromiumAddress(), port: resolveChromiumPort() };
  let previous;
  if (prior.loaded) {
    const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', CR_PREVIOUS_PLIST_PATH], { encoding: 'utf8' }));
    const environment = plist.EnvironmentVariables;
    previous = { address: environment.CHROMIUM_CDP_ADDRESS, port: Number(environment.CHROMIUM_CDP_PORT) };
    if (!previous.address || !Number.isSafeInteger(previous.port) || previous.port < 1 || previous.port > 65535) throw new Error('Previous plist has no usable CDP configuration for rollback');
  }
  assertChromiumProfileAvailable(resolveChromiumProfileDir(), prior.pid);
  const conflicts = chromiumListenerPids(selected.port).filter(pid => !prior.pid || !isDescendant(pid, prior.pid));
  if (conflicts.length) throw new Error(`CDP port ${selected.port} is held by another process; existing service preserved`);
  // The candidate uses disposable state before any persistent configuration changes.
  const probe = await promisify(execFile)(process.execPath, [resolve(PROJECT_ROOT, 'bin/disclaude.js'), 'browser', 'doctor', '--binary', binary,
    ...(resolveChromiumHeadless() ? ['--headless'] : [])], { timeout: 90_000, maxBuffer: 1024 * 1024 });
  const diagnosis = JSON.parse(probe.stdout);
  if (!diagnosis.usable) throw new Error('Selected browser failed its temporary-profile preflight');
  assertChromiumProfileAvailable(resolveChromiumProfileDir(), prior.pid);
  assertChromiumProfileVersion(resolveChromiumProfileDir(), diagnosis.cycles?.[0]?.browser);
  const stop = async () => {
    if (!chromiumServicePid().loaded) return;
    execFileSync('launchctl', buildLaunchctlInvocation('bootout', { label: LABEL_CHROMIUM }), { stdio: 'pipe' });
    if (chromiumServicePid().loaded) throw new Error('launchd service remained loaded after stop');
  };
  const ready = await transitionChromium({ paths: [config, CR_AUTO_PLIST_PATH, CR_MANUAL_PLIST_PATH], wasLoaded: prior.loaded,
    prepare: () => generateChromiumPlist(), stop,
    start: () => loadPlistAt(existsSync(CR_PLIST_PATH) ? CR_PLIST_PATH : CR_PREVIOUS_PLIST_PATH, LABEL_CHROMIUM),
    verify: async () => {
      const result = await waitChromiumReady(selected, chromiumServicePid);
      if (CR_PREVIOUS_PLIST_PATH !== CR_PLIST_PATH) rmSync(CR_PREVIOUS_PLIST_PATH, { force: true });
      return result;
    }, verifyPrevious: () => waitChromiumReady(previous, chromiumServicePid) });
  console.log(`CDP ready: ${ready.endpoint} (${ready.browser}, service PID ${ready.pid})`);
  console.log(`Temporary-profile cookie persistence: ${diagnosis.cookiePersistence}; service-profile persistence was not tested by this command.`);
}

async function withChromiumActivationLock(action) {
  const lock = `${CR_AUTO_PLIST_PATH}.activation.lock`;
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
  unloadPlistAt(LABEL_CHROMIUM);
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
  unloadPlistAt(LABEL_CHROMIUM);
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

async function cmdChromiumStatus() {
  const current = chromiumServicePid();
  let ready = false, endpoint, healthError;
  if (current.loaded && existsSync(CR_PLIST_PATH)) {
    try {
      const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', CR_PLIST_PATH], { encoding: 'utf8' }));
      const environment = plist.EnvironmentVariables || {};
      const address = environment.CHROMIUM_CDP_ADDRESS, port = Number(environment.CHROMIUM_CDP_PORT);
      if (address !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Service definition has no valid loopback CDP endpoint');
      endpoint = `http://${address}:${port}`;
      await waitChromiumReady({ address, port }, chromiumServicePid, 3000);
      ready = true;
    } catch (error) { healthError = error.message; }
  }
  console.log(JSON.stringify({ service: LABEL_CHROMIUM, ...current, cdpReady: ready, endpoint, healthError,
    definition: CR_PLIST_PATH, configuration: chromiumConfigPath(),
    autostart: existsSync(CR_AUTO_PLIST_PATH),
    configured: describeChromiumSelection(readChromiumConfig(chromiumConfigPath())),
    configurationMayDifferFromLoadedService: true, logs: { stdout: CR_STDOUT_LOG, stderr: CR_STDERR_LOG } }));
  if (current.loaded && !ready) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// launchctl commands (modern bootstrap/bootout API, Issue #5619 / T-038)
// ---------------------------------------------------------------------------

/**
 * Build a launchctl argument vector for the modern domain-target API
 * (Issue #5619, T-038). Pure so Linux CI can assert the exact commands the
 * service lifecycle uses without a real launchd:
 *
 *   bootstrap gui/<uid> <plist>   — install the definition into the domain
 *   bootout   gui/<uid>/<label>   — remove it (and stop the job)
 *   print     gui/<uid>/<label>   — inspect state ("state =", "pid =")
 *
 * `load`/`unload` (file-path form) remain available for pre-Yosemite
 * fallbacks; they take the plist path, not the service target.
 *
 * @param {'bootstrap'|'bootout'|'print'|'load'|'unload'} action
 * @param {object} [options]
 * @param {number} [options.uid] - owning uid (defaults to this process)
 * @param {string} [options.plistPath] - plist file path (bootstrap/load)
 * @param {string} [options.label] - service label (bootout/print)
 * @returns {string[]} argv for launchctl
 */
export function buildLaunchctlInvocation(action, { uid = process.getuid?.() ?? 0, plistPath = PLIST_PATH, label = LABEL } = {}) {
  const domain = `gui/${uid}`;
  switch (action) {
    case 'bootstrap':
      return ['bootstrap', domain, plistPath];
    case 'bootout':
      return ['bootout', `${domain}/${label}`];
    case 'print':
      return ['print', `${domain}/${label}`];
    case 'load':
      return ['load', plistPath];
    case 'unload':
      return ['unload', plistPath];
    default:
      throw new Error(`Unknown launchctl action: ${String(action)}`);
  }
}

/**
 * Whether the service is currently bootstrapped into the user domain, via
 * `launchctl print gui/<uid>/<label>`. Returns the captured print output so
 * `status` can surface the same state operators would see on the host.
 */
function printServiceState() {
  try {
    const output = execFileSync('launchctl', buildLaunchctlInvocation('print'), {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { loaded: true, output };
  } catch {
    return { loaded: false, output: '' };
  }
}

function loadPlist() {
  if (!existsSync(PLIST_PATH)) {
    console.error(`Plist not found: ${PLIST_PATH}`);
    console.error('Run "generate" or "install" first.');
    process.exit(1);
  }
  try {
    execFileSync('launchctl', buildLaunchctlInvocation('bootstrap'), { stdio: 'inherit' });
  } catch (error) {
    // Idempotent install/start: bootstrap fails when the label is already in
    // the domain. Confirm via print, then bootout + bootstrap so the fresh
    // plist takes effect; anything else is a real failure.
    if (!printServiceState().loaded) throw error;
    console.log('Service already bootstrapped; reloading with the new plist.');
    execFileSync('launchctl', buildLaunchctlInvocation('bootout'), { stdio: 'pipe' });
    execFileSync('launchctl', buildLaunchctlInvocation('bootstrap'), { stdio: 'inherit' });
  }
  console.log('Service loaded (launchctl bootstrap).');
}

function unloadPlist() {
  // bootout addresses the service by domain target, so it works even when
  // the plist file has already been removed; not-loaded is a no-op (stop and
  // uninstall stay idempotent).
  if (!printServiceState().loaded) {
    console.log('Service is not loaded (nothing to boot out).');
    return;
  }
  execFileSync('launchctl', buildLaunchctlInvocation('bootout'), { stdio: 'pipe' });
  console.log('Service unloaded (launchctl bootout).');
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

// Issue #5619: `--dry-run` previews the exact actions (plist content,
// launchctl command lines) without writing files or touching any service —
// the verifiable install/update path for non-macOS environments.
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Issue #5619: service-mutating commands are macOS-only. Outside darwin they
 * fail closed (unless --dry-run) so a stray `install`/`stop` on Linux can
 * never reach launchctl or alter a real service. The isolated rehearsal
 * (`launchd.mjs isolated ...`) is exempt: it runs under a com.disclaude.test.*
 * label with its own state directory and a fake launchctl on PATH, and never
 * touches the production service.
 */
function assertDarwinServiceCommand(commandName) {
  if (DRY_RUN || IS_ISOLATED) return;
  if (process.platform !== 'darwin') {
    throw new Error(
      `launchd ${commandName} changes service state and requires macOS; rerun with --dry-run to preview (nothing was changed)`
    );
  }
}

function cmdGenerate() {
  generatePlist({ dryRun: DRY_RUN });
}

function cmdInstall() {
  assertDarwinServiceCommand('install');
  if (DRY_RUN) {
    generatePlist({ dryRun: true });
    console.log(`[dry-run] would run: launchctl ${buildLaunchctlInvocation('bootstrap').join(' ')}`);
    console.log('[dry-run] no launchctl commands executed');
    return;
  }
  generatePlist();
  loadPlist();
  console.log('\nService installed and started.');
}

function cmdUninstall() {
  assertDarwinServiceCommand('uninstall');
  if (DRY_RUN) {
    console.log(`[dry-run] would run: launchctl ${buildLaunchctlInvocation('bootout').join(' ')}`);
    console.log(`[dry-run] would remove plist: ${PLIST_PATH}`);
    console.log('[dry-run] no launchctl commands executed');
    return;
  }
  unloadPlist();
  if (existsSync(PLIST_PATH)) {
    rmSync(PLIST_PATH);
    console.log(`Plist removed: ${PLIST_PATH}`);
  }
  console.log('Service uninstalled.');
}

function cmdStart() {
  assertDarwinServiceCommand('start');
  if (DRY_RUN) {
    console.log(`[dry-run] would run: npm run build (cwd ${PROJECT_ROOT})`);
    generatePlist({ dryRun: true });
    console.log(`[dry-run] would run: launchctl ${buildLaunchctlInvocation('bootstrap').join(' ')}`);
    console.log('[dry-run] no launchctl commands executed');
    return;
  }
  build();
  generatePlist();
  loadPlist();
  console.log('\nService built and started.');
}

function cmdStop() {
  assertDarwinServiceCommand('stop');
  if (DRY_RUN) {
    console.log(`[dry-run] would run: launchctl ${buildLaunchctlInvocation('bootout').join(' ')}`);
    console.log('[dry-run] no launchctl commands executed');
    return;
  }
  unloadPlist();
}

function cmdRestart() {
  assertDarwinServiceCommand('restart');
  if (DRY_RUN) {
    console.log(`[dry-run] would run: launchctl ${buildLaunchctlInvocation('bootout').join(' ')}`);
    console.log(`[dry-run] would run: npm run build (cwd ${PROJECT_ROOT})`);
    generatePlist({ dryRun: true });
    console.log(`[dry-run] would run: launchctl ${buildLaunchctlInvocation('bootstrap').join(' ')}`);
    console.log('[dry-run] no launchctl commands executed');
    return;
  }
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
  if (DRY_RUN) {
    console.log(`[dry-run] would run: launchctl ${buildLaunchctlInvocation('print').join(' ')}`);
    console.log(`[dry-run] plist: ${PLIST_PATH}`);
    console.log('[dry-run] no launchctl commands executed');
    return;
  }
  // Issue #5619 (T-038): status comes from `launchctl print gui/<uid>/<label>`
  // — the modern replacement for `launchctl list | grep`. Surface its state
  // and pid lines plus the operator-relevant paths.
  const state = printServiceState();
  if (state.loaded) {
    const keyLines = state.output
      .split('\n')
      .filter((line) => /^\s*(state|pid)\s*=/.test(line))
      .map((line) => line.trim());
    console.log(keyLines.length ? keyLines.join('\n') : `Service is loaded (${LABEL}).`);
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
// Issue #5619: `launchd.mjs service <command>` is an explicit alias for the
// application service so `disclaude service install|start|stop|status` maps
// 1:1 onto this script; every command accepts --dry-run.
const FIRST_ARG = process.argv[2];
const IS_CHROMIUM = FIRST_ARG === 'chromium' || FIRST_ARG === 'chromium-cdp' || FIRST_ARG === 'chromium-isolated';
const IS_ISOLATED = FIRST_ARG === 'isolated';
const IS_SERVICE_SELECTOR = FIRST_ARG === 'service';
const command = IS_CHROMIUM || IS_ISOLATED || IS_SERVICE_SELECTOR ? process.argv[3] : FIRST_ARG;

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
       node scripts/launchd.mjs service <command>
       node scripts/launchd.mjs isolated <command>

Commands (add --dry-run to preview actions without running launchctl):
  generate    Generate plist file (from the .disclaude config; Issue #5619)
  install     Generate + load (first-time setup)
  uninstall   Unload + remove plist
  start       Build + load
  stop        Unload (keep plist)
  restart     Build + unload + load
  logs        Tail log files [--lines=N]
  status      Show service status

The \`service\` form is what \`disclaude service <command>\` forwards to. The
plist takes its entry path, API port and env block from the disclaude config
(launchd.entry / launchd.apiPort / launchd.env or env:; defaults are the
package checkout entry, port 19200, and no extra env).

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
  if (IS_CHROMIUM) selectChromiumPlistPath();
  try {
    if (IS_CHROMIUM && !['status', 'logs'].includes(command)) await withChromiumActivationLock(table[command]);
    else await table[command]();
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
