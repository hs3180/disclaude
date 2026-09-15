#!/usr/bin/env node
/** Explicit browser selection before delegating to the platform service manager. */
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { chromiumConfigPath, readChromiumConfig } from './chromium-config.mjs';
import { chromiumDownloadLayout, planChromiumDownload, installChromiumCandidate } from './chromium-download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function parseSetupArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (['--yes', '--dry-run', '--headless', '--headed', '--isolated', '--autostart', '--no-autostart', '--download', '--allow-unverified-signature'].includes(name)) {
      if (name in result) throw new Error(`Repeated option: ${name}`);
      result[name] = true;
    } else if (['--binary', '--profile', '--port', '--revision', '--browser-dir'].includes(name)) {
      if (name in result || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Provide one value for ${name}`);
      result[name] = args[++i];
    } else { throw new Error(`Unknown setup option: ${name}`); }
  }
  if (result['--binary'] && (result['--download'] || result['--revision'] || result['--browser-dir'] || result['--allow-unverified-signature'])) throw new Error('Download options cannot be combined with an existing --binary');
  if (result['--autostart'] && result['--no-autostart']) throw new Error('Choose either --autostart or --no-autostart');
  if (result['--headless'] && result['--headed']) throw new Error('Choose either --headed or --headless');
  if (result['--port'] && (!/^\d+$/.test(result['--port']) || +result['--port'] < 1 || +result['--port'] > 65535)) throw new Error('Port must be between 1 and 65535');
  for (const name of ['--binary', '--profile', '--browser-dir']) if (result[name] && !isAbsolute(result[name])) throw new Error(`${name} must be an absolute path`);
  return result;
}

export function discoverSetupBrowsers(platform = process.platform) {
  const paths = platform === 'darwin'
    ? ['/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].flatMap(name => {
      try { return [execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()]; } catch { return []; }
    });
  const seen = new Set();
  return paths.flatMap(path => {
    try {
      accessSync(path, constants.X_OK);
      const executable = realpathSync(path);
      if (seen.has(executable)) return [];
      seen.add(executable);
      return [{ path: executable, kind: /chromium/i.test(path) ? 'Chromium' : 'Chrome' }];
    } catch { return []; }
  });
}

export async function collectSetupSelection(options, saved, ask, download) {
  let binary = options['--binary'];
  if (options['--download']) { if (!download) throw new Error('Chromium download is unavailable on this platform'); binary = await download(); }
  if (!binary) {
    if (!ask) throw new Error('Non-interactive setup requires --binary /absolute/path or --download, plus --yes (or --dry-run)');
    const browsers = discoverSetupBrowsers();
    const choices = browsers.map((browser, index) => `${index + 1}. ${browser.kind}: ${browser.path}`).join('\n');
    const preferred = browsers.findIndex(browser => browser.kind === 'Chromium');
    const defaultChoice = preferred >= 0 ? preferred + 1 : download ? browsers.length + 2 : 1;
    const answer = (await ask(`${choices}${choices ? '\n' : ''}${browsers.length + 1}. Custom executable path${download ? `\n${browsers.length + 2}. Download independent Chromium` : ''}\nChoose browser [${defaultChoice}]: `)).trim() || String(defaultChoice);
    const selected = Number(answer);
    if (!Number.isInteger(selected) || selected < 1 || selected > browsers.length + (download ? 2 : 1)) throw new Error('Invalid browser selection');
    binary = selected <= browsers.length ? browsers[selected - 1].path
      : selected === browsers.length + 2 ? await download() : (await ask('Absolute browser executable path: ')).trim();
  }
  if (!isAbsolute(binary)) throw new Error('Browser executable path must be absolute');
  accessSync(binary, constants.X_OK);
  binary = realpathSync(binary);
  let profile = options['--profile'] || saved.CHROMIUM_CDP_PROFILE_DIR || (process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/disclaude/chromium-cdp')
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'disclaude/chromium-cdp'));
  let port = options['--port'] || saved.CHROMIUM_CDP_PORT || '9222';
  let headed = options['--headless'] ? '0' : options['--headed'] ? '1' : saved.CHROMIUM_CDP_HEADED || '1';
  let autostart = options['--no-autostart'] ? '0' : options['--autostart'] ? '1' : saved.CHROMIUM_CDP_AUTOSTART || '1';
  if (ask) {
    if (!options['--profile']) profile = (await ask(`Dedicated persistent profile [${profile}]: `)).trim() || profile;
    if (!options['--port']) port = (await ask(`Loopback CDP port [${port}]: `)).trim() || port;
    if (!options['--headless'] && !options['--headed']) {
      const choice = (await ask(`Visible browser window? [${headed === '1' ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
      if (choice && !['y', 'yes', 'n', 'no'].includes(choice)) throw new Error('Answer yes or no for visible browser');
      if (choice) headed = ['y', 'yes'].includes(choice) ? '1' : '0';
    }
  }
  if (ask && !options['--autostart'] && !options['--no-autostart']) {
    const choice = (await ask(`Start automatically at login? [${autostart === '1' ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
    if (choice && !['y', 'yes', 'n', 'no'].includes(choice)) throw new Error('Answer yes or no for login autostart');
    if (choice) autostart = ['y', 'yes'].includes(choice) ? '1' : '0';
  }
  if (!isAbsolute(profile) || /[\r\n\0]/.test(profile)) throw new Error('Profile path must be absolute and contain no control characters');
  if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('Port must be between 1 and 65535');
  return { CHROMIUM_CDP_BINARY: binary, CHROMIUM_CDP_PROFILE_DIR: profile,
    CHROMIUM_CDP_PORT: port, CHROMIUM_CDP_ADDRESS: '127.0.0.1', CHROMIUM_CDP_HEADED: headed, CHROMIUM_CDP_AUTOSTART: autostart };
}

async function main() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Browser setup currently supports macOS and Linux');
  if (process.argv.includes('--help')) { console.log('Usage: disclaude chromium-cdp setup [--binary /path|--download] [--revision number] [--browser-dir /path] [--allow-unverified-signature] [--profile /path] [--port number] [--headed|--headless] [--autostart|--no-autostart] [--yes|--dry-run]'); return; }
  const options = parseSetupArgs(process.argv.slice(4));
  if (!process.stdin.isTTY && !options['--yes'] && !options['--dry-run']) throw new Error('Setup needs a terminal; pass explicit --binary or --download, and --yes for non-interactive use');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  const rl = process.stdin.isTTY && !options['--yes'] ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    const ask = rl ? text => rl.question(text, { signal: controller.signal }) : undefined;
    let artifact, supported = true;
    try { chromiumDownloadLayout(); } catch { supported = false; }
    const download = supported ? async () => {
      const plan = await planChromiumDownload({ revision: options['--revision'], directory: options['--browser-dir'], signal: controller.signal });
      const preview = { source: plan.url, revision: plan.revision, bytes: plan.size, md5: plan.md5, destination: plan.destination, signature: 'not-yet-checked' };
      if (options['--dry-run']) { console.log(JSON.stringify({ downloadPlan: preview, installed: false }, null, 2)); throw Object.assign(new Error('Download preview complete'), { code: 'DOWNLOAD_PLAN_ONLY' }); }
      console.log(JSON.stringify({ downloadPlan: preview }, null, 2));
      if (!options['--yes'] && !['y', 'yes'].includes((await ask('Download and verify this Chromium candidate? [y/N]: ')).trim().toLowerCase())) throw new Error('Download cancelled; no service changes');
      artifact = await installChromiumCandidate(plan, { headless: true, signal: controller.signal,
        allowUnverifiedSignature: Boolean(options['--allow-unverified-signature']),
        confirmSignature: async signature => {
          console.error(`macOS signature verification: ${signature.detail}`);
          return ask ? ['y', 'yes'].includes((await ask('Use this official archive despite its failed signature check? [y/N]: ')).trim().toLowerCase()) : false;
        } });
      return artifact.binary;
    } : undefined;
    let selection;
    try { selection = await collectSetupSelection(options, readChromiumConfig(chromiumConfigPath()), ask, download); }
    catch (error) { if (error.code === 'DOWNLOAD_PLAN_ONLY') return; throw error; }
    let version;
    try { version = execFileSync(selection.CHROMIUM_CDP_BINARY, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(); }
    catch { throw new Error('Selected executable did not report its version; current service unchanged'); }
    const summary = { executable: selection.CHROMIUM_CDP_BINARY, version, profile: selection.CHROMIUM_CDP_PROFILE_DIR,
      endpoint: `http://127.0.0.1:${selection.CHROMIUM_CDP_PORT}`, mode: selection.CHROMIUM_CDP_HEADED === '1' ? 'headed' : 'headless',
      autostart: selection.CHROMIUM_CDP_AUTOSTART === '1', service: process.platform === 'darwin' ? 'launchd' : 'systemd user', configuration: chromiumConfigPath(),
      ...(artifact ? { download: { source: artifact.url, revision: artifact.revision, archiveSha256: artifact.archiveSha256, signature: artifact.signature, reused: artifact.reused } } : {}) };
    console.log(JSON.stringify(summary, null, 2));
    if (options['--dry-run']) return;
    if (!options['--yes']) {
      const answer = (await ask('Apply this browser configuration and verify startup? [y/N]: ')).trim().toLowerCase();
      if (!['y', 'yes'].includes(answer)) { console.log('Setup cancelled; no service changes'); return; }
    }
    const adapter = join(root, 'scripts', process.platform === 'linux' ? 'chromium-systemd.mjs' : 'launchd.mjs');
    const selector = options['--isolated'] ? 'chromium-isolated' : 'chromium-cdp';
    const env = { ...process.env, ...selection };
    let loaded;
    let status;
    try { status = execFileSync(process.execPath, [adapter, selector, 'status'], { env, encoding: 'utf8', timeout: 15_000 }); }
    catch (error) {
      if (error.status === 1 && String(error.stdout).trim().startsWith('{')) status = String(error.stdout);
      else throw error;
    }
    loaded = JSON.parse(status).loaded;
    const child = spawn(process.execPath, [adapter, selector, loaded ? 'restart' : 'install'], { env, stdio: 'inherit' });
    const forwardInterrupt = () => child.kill('SIGINT');
    const forwardTerminate = () => child.kill('SIGTERM');
    process.on('SIGINT', forwardInterrupt); process.on('SIGTERM', forwardTerminate);
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Browser service setup failed (${code}); inspect recovery result above`)));
      });
    } finally { process.off('SIGINT', forwardInterrupt); process.off('SIGTERM', forwardTerminate); }
  } finally { rl?.close(); process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
