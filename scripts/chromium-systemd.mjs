#!/usr/bin/env node
/** Native Linux user-service management for the persistent Chromium browser. */
import { execFileSync, execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromiumConfigPath, loadChromiumConfig, saveChromiumConfig } from './chromium-config.mjs';
import { replaceChromiumFile, transitionChromium, chromiumListenerPids, isDescendant, waitChromiumReady } from './browser-service-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function systemdQuote(value, command = false) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid control character in service configuration');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => command ? '$$' : '$') + '"';
}

export function resolveLinuxBrowser(env = process.env) {
  const binary = env.CHROMIUM_CDP_BINARY;
  const profile = env.CHROMIUM_CDP_PROFILE_DIR || join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'disclaude/chromium-cdp');
  if (!binary || !isAbsolute(binary)) throw new Error('Set CHROMIUM_CDP_BINARY to the selected browser executable absolute path');
  if (!isAbsolute(profile)) throw new Error('CHROMIUM_CDP_PROFILE_DIR must be absolute');
  accessSync(binary, constants.X_OK);
  const rawPort = env.CHROMIUM_CDP_PORT || '9222';
  if (!/^\d+$/.test(rawPort) || +rawPort < 1 || +rawPort > 65535) throw new Error('CHROMIUM_CDP_PORT must be between 1 and 65535');
  const address = env.CHROMIUM_CDP_ADDRESS || '127.0.0.1';
  if (address !== '127.0.0.1') throw new Error('Native Linux browser service requires the loopback address 127.0.0.1');
  const headed = env.CHROMIUM_CDP_HEADED || '1';
  if (!['0', '1'].includes(headed)) throw new Error('CHROMIUM_CDP_HEADED must be 0 or 1');
  if (headed === '1' && !env.DISPLAY && !env.WAYLAND_DISPLAY) throw new Error('Headed browser requires a desktop display; set CHROMIUM_CDP_HEADED=0 for headless operation');
  const autostart = env.CHROMIUM_CDP_AUTOSTART;
  if (autostart !== undefined && !['0', '1'].includes(autostart)) throw new Error('CHROMIUM_CDP_AUTOSTART must be 0 or 1');
  return { binary: realpathSync(binary), profile, port: +rawPort, address, headed, autostart };
}

export function renderLinuxBrowserUnit(selection, env = process.env) {
  const args = [selection.binary, `--user-data-dir=${selection.profile}`, `--remote-debugging-port=${selection.port}`,
    `--remote-debugging-address=${selection.address}`, '--no-first-run', '--no-default-browser-check',
    ...(selection.headed === '0' ? ['--headless=new'] : []), 'about:blank'];
  const environment = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'].filter(key => env[key])
    .map(key => `Environment=${systemdQuote(`${key}=${env[key]}`)}`).join('\n');
  return `# disclaude-managed-chromium-v1\n# disclaude-endpoint: ${JSON.stringify({ address: selection.address, port: selection.port })}\n[Unit]\nDescription=Disclaude Chromium CDP\n[Service]\nType=exec\nExecStart=${args.map(arg => systemdQuote(arg, true)).join(' ')}\nRestart=on-failure\nRestartSec=2\nKillMode=control-group\nTimeoutStopSec=15\n${environment}\n[Install]\nWantedBy=default.target\n`;
}

function systemctl(...args) {
  return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
}

function pathsForService(isolated) {
  const hasIntent = ['DISCLAUDE_SYSTEMD_ISOLATED', 'DISCLAUDE_SYSTEMD_UNIT', 'DISCLAUDE_SYSTEMD_STATE_DIR'].some(key => key in process.env);
  if (hasIntent && !isolated) throw new Error('Systemd overrides require the chromium-isolated selector');
  const unit = isolated ? process.env.DISCLAUDE_SYSTEMD_UNIT : 'disclaude-chromium-cdp.service';
  if (isolated) {
    if (process.env.DISCLAUDE_SYSTEMD_ISOLATED !== '1' || !/^disclaude-test-[a-z0-9.-]+\.service$/.test(unit || '')) throw new Error('Isolated systemd requires its flag and a disclaude-test-*.service unit');
    const state = process.env.DISCLAUDE_SYSTEMD_STATE_DIR;
    if (!state || !isAbsolute(state)) throw new Error('Isolated systemd requires an absolute state directory');
    const actualRoot = realpathSync(state);
    for (const path of [chromiumConfigPath(), process.env.CHROMIUM_CDP_PROFILE_DIR]) {
      if (!path || !isAbsolute(path)) throw new Error('Isolated systemd requires explicit config/profile paths');
      const part = relative(state, path);
      if (!part || part === '..' || part.startsWith('../') || isAbsolute(part)) throw new Error('Isolated systemd paths must be inside the test state directory');
      let ancestor = path;
      while (!existsSync(ancestor)) ancestor = dirname(ancestor);
      const actual = relative(actualRoot, realpathSync(ancestor));
      if (actual === '..' || actual.startsWith('../') || isAbsolute(actual)) throw new Error('Isolated systemd path escapes through a symlink');
    }
    if (!process.env.CHROMIUM_CDP_PORT) throw new Error('Isolated systemd requires an explicit port');
  }
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
  if (!isAbsolute(unitDir)) throw new Error('User unit directory must be absolute');
  return { unit, file: join(unitDir, unit), config: chromiumConfigPath() };
}

async function main() {
  const selector = process.argv[2];
  const command = process.argv[3];
  if (!['chromium-cdp', 'chromium-isolated'].includes(selector) || !['generate', 'install', 'start', 'restart', 'stop', 'uninstall', 'status', 'logs'].includes(command)) {
    throw new Error('Usage: disclaude chromium-cdp <generate|install|start|restart|stop|uninstall|status|logs> [--no-autostart]');
  }
  if (process.argv.slice(4).some(arg => arg !== '--no-autostart' || command !== 'install')) throw new Error('Only install accepts --no-autostart; no other flags are supported');
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Native browser service requires a non-root Linux user with a running user-level systemd manager');
  try { systemctl('show-environment'); execFileSync('lsof', ['-v'], { stdio: 'ignore' }); }
  catch { throw new Error('User-level systemd or lsof is unavailable. Run within an active Linux user session with systemd and lsof installed; no service was changed.'); }
  const paths = pathsForService(selector === 'chromium-isolated');
  const state = () => {
    let output;
    try { output = systemctl('show', paths.unit, '--property=ActiveState,MainPID,LoadState'); }
    catch (error) { if (String(error.stdout).includes('LoadState=not-found')) output = String(error.stdout); else throw error; }
    const fields = Object.fromEntries(output.trim().split('\n').map(line => line.split('=')));
    return { loaded: ['active', 'activating', 'reloading'].includes(fields.ActiveState), pid: Number(fields.MainPID) || undefined, state: fields.ActiveState };
  };
  if (command === 'logs') { process.stdout.write(execFileSync('journalctl', ['--user', '-u', paths.unit, '-n', '100', '--no-pager'], { encoding: 'utf8' })); return; }
  if (command === 'status') {
    const current = state();
    let ready = false;
    if (current.loaded && existsSync(paths.file)) {
      const endpoint = JSON.parse(readFileSync(paths.file, 'utf8').match(/^# disclaude-endpoint: (.+)$/m)?.[1] || 'null');
      if (endpoint) { try { await waitChromiumReady(endpoint, state, 3000); ready = true; } catch {} }
    }
    let autostart = false;
    try { autostart = /^enabled(?:-runtime)?\s*$/.test(systemctl('is-enabled', paths.unit)); } catch {}
    console.log(JSON.stringify({ unit: paths.unit, ...current, cdpReady: ready, autostart }));
    if (current.loaded && !ready) process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(paths.file), { recursive: true, mode: 0o700 });
  const lock = `${paths.file}.activation.lock`;
  try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Activation lock exists at ${lock}; check its recorded PID before removing a stale lock`); throw error; }
  try {
    if (existsSync(paths.file) && !readFileSync(paths.file, 'utf8').startsWith('# disclaude-managed-chromium-v1\n')) throw new Error('Existing unit is not managed by this CLI; preserve it and resolve migration before replacement');
    if (command === 'stop' || command === 'uninstall') {
      if (!existsSync(paths.file) && !state().loaded) { console.log('Chromium service is not installed; profile preserved'); return; }
      systemctl('stop', paths.unit);
      if (command === 'uninstall') { systemctl('disable', paths.unit); rmSync(paths.file, { force: true }); systemctl('daemon-reload'); }
      console.log(`Chromium service ${command === 'stop' ? 'stopped' : 'uninstalled'}; profile preserved`);
      return;
    }
    loadChromiumConfig();
    let enabledBefore = false, changedEnable = false;
    try { enabledBefore = /^enabled(?:-runtime)?\s*$/.test(systemctl('is-enabled', paths.unit)); } catch {}
    const selection = resolveLinuxBrowser();
    selection.autostart = process.argv.includes('--no-autostart') ? '0'
      : selection.autostart ?? (command === 'install' || enabledBefore ? '1' : '0');
    const unitText = renderLinuxBrowserUnit(selection);
    const prepare = () => {
      mkdirSync(selection.profile, { recursive: true, mode: 0o700 });
      saveChromiumConfig({ CHROMIUM_CDP_BINARY: selection.binary, CHROMIUM_CDP_PROFILE_DIR: selection.profile,
        CHROMIUM_CDP_PORT: String(selection.port), CHROMIUM_CDP_ADDRESS: selection.address, CHROMIUM_CDP_HEADED: selection.headed, CHROMIUM_CDP_AUTOSTART: selection.autostart });
      replaceChromiumFile(paths.file, Buffer.from(unitText));
    };
    if (command === 'generate') { prepare(); console.log(paths.file); return; }
    const prior = state();
    if (prior.loaded && command !== 'restart') throw new Error('Browser service already running; use restart to change configuration');
    const priorText = existsSync(paths.file) ? readFileSync(paths.file, 'utf8') : '';
    const previous = JSON.parse(priorText.match(/^# disclaude-endpoint: (.+)$/m)?.[1] || 'null');
    if (prior.loaded && !previous) throw new Error('Previous endpoint is missing; cannot provide verified rollback');
    if (chromiumListenerPids(selection.port).some(pid => !prior.pid || !isDescendant(pid, prior.pid))) throw new Error(`CDP port ${selection.port} belongs to another process; existing service preserved`);
    const probe = await promisify(execFile)(process.execPath, [join(root, 'bin/disclaude.js'), 'browser', 'doctor', '--binary', selection.binary,
      ...(selection.headed === '0' ? ['--headless'] : [])], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const diagnosis = JSON.parse(probe.stdout);
    if (!diagnosis.usable) throw new Error('Selected browser failed its temporary-profile preflight');
    let ready;
    try { ready = await transitionChromium({ paths: [paths.config, paths.file], wasLoaded: prior.loaded, prepare,
      stop() { systemctl('stop', paths.unit); if (changedEnable) systemctl(enabledBefore ? 'enable' : 'disable', paths.unit); },
      start() { systemctl('daemon-reload'); try { systemctl('reset-failed', paths.unit); } catch {} systemctl('start', paths.unit); },
      async verify() {
        const result = await waitChromiumReady(selection, state);
        changedEnable = true;
        systemctl(selection.autostart === '1' ? 'enable' : 'disable', paths.unit);
        return result;
      }, verifyPrevious: () => waitChromiumReady(previous, state) });
    } catch (error) {
      // Also forget a failed first-install unit after its absent file is restored.
      try { systemctl('daemon-reload'); }
      catch (reloadError) { throw new Error(`${error.message}; restored unit reload failed: ${reloadError.message}`); }
      throw error;
    }
    console.log(JSON.stringify({ unit: paths.unit, cdpReady: true, ...ready, autostart: selection.autostart === '1', temporaryProfileCookiePersistence: diagnosis.cookiePersistence }));
  } finally { rmSync(lock, { force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
