#!/usr/bin/env node
/** Read-only Chromium CDP status and repair hints. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitChromiumReady } from './browser-service-state.mjs';
import { chromiumConfigPath, readChromiumConfig } from './chromium-config.mjs';

const PROFILE_DEFAULTS = {
  darwin: home => join(home, 'Library/Application Support/disclaude/chromium-cdp'),
  linux: (home, env) => join(env.XDG_DATA_HOME || join(home, '.local/share'), 'disclaude/chromium-cdp'),
};

function sourceFor(key, env, saved) {
  if (Object.hasOwn(env, key)) return 'environment';
  if (Object.hasOwn(saved, key)) return 'chromium-cdp.json';
  return 'platform default';
}

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { requestUrl: `${url.href.replace(/\/+$/u, '')}/json/version`, display: url.origin };
  } catch { return null; }
}

function isExecutable(path) {
  if (!path) return false;
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

export function resolveChromiumStatusConfig({ env = process.env, home = env.HOME || homedir(), platform = process.platform,
  exists = existsSync, executable = isExecutable } = {}) {
  let configPath, saved = {}, configState = 'missing';
  try {
    configPath = chromiumConfigPath(env, home);
    saved = readChromiumConfig(configPath);
    configState = exists(configPath) ? 'loaded' : 'missing';
  } catch {
    configState = 'invalid';
  }

  const effective = { ...env };
  for (const [key, value] of Object.entries(saved)) {
    if (!(key in effective)) effective[key] = value;
  }
  const binary = effective.CHROMIUM_CDP_BINARY || null;
  const profileSource = sourceFor('CHROMIUM_CDP_PROFILE_DIR', env, saved);
  const defaultProfile = PROFILE_DEFAULTS[platform]?.(home, effective) ?? null;
  const profile = effective.CHROMIUM_CDP_PROFILE_DIR || defaultProfile;
  const address = effective.CHROMIUM_CDP_ADDRESS || '127.0.0.1';
  const port = effective.CHROMIUM_CDP_PORT || '9222';
  const endpointValue = effective.BU_CDP_URL || `http://${address}:${port}`;
  const endpoint = safeEndpoint(endpointValue);

  return {
    configFile: { path: configPath ?? null, state: configState },
    executable: {
      path: binary,
      source: binary ? sourceFor('CHROMIUM_CDP_BINARY', env, saved) : 'not configured',
      available: executable(binary),
    },
    profile: {
      path: profile,
      source: profile ? profileSource : 'not configured for this platform',
      exists: Boolean(profile && exists(profile)),
    },
    endpoint: endpoint ? endpoint.display : null,
    endpointRequestUrl: endpoint?.requestUrl,
    endpointValid: Boolean(endpoint),
  };
}

export function parseMacServiceState(output) {
  const pid = Number(output.match(/(?:^|[\s,{])"?PID"?\s*=\s*(\d+)/mu)?.[1]) || undefined;
  return { manager: 'launchd', unit: 'com.disclaude.chromium-cdp', state: pid ? 'running' : 'loaded', pid };
}

export function parseSystemdServiceState(output) {
  const fields = Object.fromEntries(output.trim().split(/\r?\n/u).map(line => {
    const index = line.indexOf('=');
    return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
  }));
  const activeState = fields.ActiveState || 'unknown';
  const state = fields.LoadState === 'not-found' ? 'not-installed'
    : ['active', 'activating', 'reloading'].includes(activeState) ? 'running'
      : activeState === 'inactive' || activeState === 'failed' ? activeState : 'unknown';
  return { manager: 'systemd', unit: 'disclaude-chromium-cdp.service', state,
    pid: Number(fields.MainPID) || undefined };
}

export function inspectManagedService({ platform = process.platform, inContainer = false,
  run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1500 }) } = {}) {
  if (platform === 'darwin') {
    try { return parseMacServiceState(run('launchctl', ['list', 'com.disclaude.chromium-cdp'])); }
    catch { return { manager: 'launchd', unit: 'com.disclaude.chromium-cdp', state: 'not-loaded' }; }
  }
  if (platform === 'linux' && inContainer) {
    return { manager: 'docker', unit: 'chromium container', state: 'external' };
  }
  if (platform === 'linux') {
    try { return parseSystemdServiceState(run('systemctl', ['--user', 'show', 'disclaude-chromium-cdp.service',
      '--property=LoadState,ActiveState,MainPID'])); }
    catch { return { manager: 'systemd', unit: 'disclaude-chromium-cdp.service', state: 'unavailable' }; }
  }
  return { manager: 'unsupported', unit: null, state: 'unknown' };
}

function detectContainer(env = process.env, exists = existsSync, read = readFileSync) {
  if (env.container || env.DOCKER_CONTAINER || exists('/.dockerenv')) return true;
  try { return /docker|containerd|kubepods/iu.test(read('/proc/1/cgroup', 'utf8')); } catch { return false; }
}

async function probeCdp(config, fetchImpl = globalThis.fetch) {
  if (!config.endpointValid || !config.endpointRequestUrl) return { reachable: false, result: 'invalid-endpoint' };
  try {
    const response = await fetchImpl(config.endpointRequestUrl, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { reachable: false, result: `http-${response.status}` };
    const body = await response.json();
    const product = typeof body?.Browser === 'string' ? body.Browser.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 80) : undefined;
    return { reachable: true, result: 'reachable', ...(product ? { browser: product } : {}) };
  } catch (error) {
    return { reachable: false, result: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

function repairHints(config, service, cdp, runtimeConfiguration, cdpReady) {
  const hints = [];
  const managedServiceReady = cdpReady === true;
  if (runtimeConfiguration?.state === 'invalid') {
    hints.push({ code: 'invalid-runtime-config', message: 'The selected disclaude.config.yaml could not be read. Correct its YAML before relying on environment-based Chromium settings.' });
  }
  if (config.configFile.state === 'invalid') {
    hints.push({ code: 'invalid-config', message: 'Chromium configuration could not be read. Review the selected chromium-cdp.json and rerun setup after correcting it.' });
  }
  if (!managedServiceReady && service.manager !== 'docker' && (!config.executable.path || !config.executable.available)) {
    hints.push({ code: 'browser-executable', message: 'Select an executable browser with `disclaude chromium-cdp setup --binary /absolute/path/to/chrome`.' });
  }
  if (!managedServiceReady) {
    if (!config.profile.path || !isAbsolute(config.profile.path)) {
      hints.push({ code: 'profile-path', message: 'Set CHROMIUM_CDP_PROFILE_DIR to an absolute persistent Profile directory.' });
    } else if (!config.profile.exists && service.manager !== 'docker') {
      hints.push({ code: 'profile-missing', message: 'The selected Profile directory is absent. Review the path and use the setup command to initialize the managed service.' });
    }
  }
  if (service.state === 'external') {
    hints.push({ code: 'docker-service', message: 'Inspect the managed browser container with `docker compose ps chromium` and its logs with `docker compose logs chromium`.' });
  } else if (service.state === 'not-loaded' || service.state === 'not-installed' || service.state === 'inactive') {
    hints.push({ code: 'service-stopped', message: 'Start the managed Chromium service with `disclaude chromium-cdp start` after confirming its selected browser and Profile.' });
  } else if (service.state === 'unavailable' || service.state === 'unknown') {
    hints.push({ code: 'service-state', message: 'The service manager state is unavailable here. Run status from the host session that owns launchd or the systemd user service.' });
  }
  if (!cdp.reachable) {
    hints.push({ code: 'cdp-unreachable', message: config.endpointValid
      ? 'Check the configured CDP host and port; when the service is running, inspect `disclaude chromium-cdp logs` for startup errors.'
      : 'Set a valid CHROMIUM_CDP_ADDRESS and CHROMIUM_CDP_PORT or BU_CDP_URL before checking CDP reachability.' });
  } else if (service.state === 'running' && cdpReady === false) {
    hints.push({ code: 'cdp-service-owner', message: 'CDP responds, but its listener could not be verified as belonging to the managed service. Inspect the configured port owner before changing the service.' });
  }
  return hints;
}

export async function diagnoseChromiumCdp({ env = process.env, home = env.HOME || homedir(), platform = process.platform,
  inContainer = detectContainer(env), exists = existsSync, executable = isExecutable, run,
  fetchImpl = globalThis.fetch, readinessProbe = waitChromiumReady,
  runtimeConfiguration = { state: 'not-checked', path: null } } = {}) {
  const config = resolveChromiumStatusConfig({ env, home, platform, exists, executable });
  const service = inspectManagedService({ platform, inContainer, ...(run ? { run } : {}) });
  const cdp = await probeCdp(config, fetchImpl);
  const inDockerContext = service.manager === 'docker';
  let cdpReady = null;
  if (['launchd', 'systemd'].includes(service.manager) && config.endpointRequestUrl) {
    try {
      const endpoint = new URL(config.endpointRequestUrl);
      if (endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1') {
        cdpReady = false;
        if (service.state === 'running' && cdp.reachable) {
          const port = Number(endpoint.port) || 80;
          await readinessProbe({ address: endpoint.hostname, port }, () => service, 3000);
          cdpReady = true;
        }
      }
    } catch { cdpReady = false; }
  }
  return {
    platform,
    configuration: config.configFile,
    runtimeConfiguration,
    executable: { ...config.executable, available: inDockerContext ? null : config.executable.available,
      checkedIn: inDockerContext ? 'docker-container' : 'host' },
    profile: { ...config.profile, exists: inDockerContext ? null : config.profile.exists,
      checkedIn: inDockerContext ? 'docker-container' : 'host' },
    managedService: service,
    cdp: { endpoint: config.endpoint, ...cdp },
    cdpReady,
    configurationMayDifferFromLoadedService: true,
    actions: repairHints(config, service, cdp, runtimeConfiguration, cdpReady),
  };
}

function parseArgs(args) {
  let configPath;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--help', '-h'].includes(arg)) return { help: true };
    if (arg === '--config' || arg === '-c') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--config requires a path');
      configPath = value;
    } else throw new Error(`Unknown status option: ${arg}`);
  }
  return { configPath };
}

async function main() {
  const forwardedArgs = process.argv.slice(2);
  const args = ['chromium-cdp', 'chromium-isolated'].includes(forwardedArgs[0])
    ? forwardedArgs.slice(2)
    : ['status', 'doctor'].includes(forwardedArgs[0]) ? forwardedArgs.slice(1) : forwardedArgs;
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: disclaude chromium-cdp <status|doctor> [--config PATH]\nRead-only: reports the selected executable/Profile, managed service state, CDP reachability, and repair hints. On macOS/Linux hosts, cdpReady also verifies stable discovery and listener ownership. It never starts or stops a service or edits browser state.');
    return;
  }
  const options = parseArgs(args);
  if (options.configPath) process.env.DISCLAUDE_CONFIG_PATH = options.configPath;
  let configuredEnvironment = {};
  let runtimeConfiguration = { state: 'missing', path: null };
  try {
    const discovery = await import('@disclaude/core/config-discovery');
    const selected = options.configPath ? resolve(options.configPath) : discovery.discoverConfigFile().path;
    configuredEnvironment = discovery.loadConfigEnvironment(options.configPath);
    runtimeConfiguration = { state: selected && existsSync(selected) ? 'loaded' : 'missing', path: selected || null };
  } catch {
    runtimeConfiguration = { state: 'invalid', path: options.configPath ? resolve(options.configPath) : null };
  }
  const env = { ...configuredEnvironment, ...process.env };
  const report = await diagnoseChromiumCdp({ env, runtimeConfiguration });
  console.log(JSON.stringify(report));
  if ((report.managedService.state === 'running' && report.cdpReady === false) ||
      (report.managedService.state === 'external' && !report.cdp.reachable)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    console.error(JSON.stringify({ error: 'Chromium status failed; inspect configuration paths and permissions without copying the Profile.' }));
    process.exitCode = 1;
  });
}
