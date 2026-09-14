import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromiumConfigPath, loadChromiumConfig, saveChromiumConfig, readChromiumConfig } from '../scripts/chromium-config.mjs';

function sandbox(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'chromium config '));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('persistent Chromium configuration', () => {
  it('resolves outside the installed package and rejects cwd-relative paths', () => {
    expect(chromiumConfigPath({}, '/operator')).toBe('/operator/.config/disclaude/chromium-cdp.json');
    expect(chromiumConfigPath({ XDG_CONFIG_HOME: '/config' })).toBe('/config/disclaude/chromium-cdp.json');
    expect(() => chromiumConfigPath({ DISCLAUDE_CHROMIUM_CONFIG: './browser.json' })).toThrow('absolute');
  });

  it('restores the selected browser/profile/port in a fresh process from another cwd', () => sandbox(dir => {
    const file = join(dir, 'config/browser.json');
    const selection = { CHROMIUM_CDP_BINARY: '/apps/Independent Chromium', CHROMIUM_CDP_PROFILE_DIR: '/profiles/automation', CHROMIUM_CDP_PORT: '9223', CHROMIUM_CDP_HEADED: '1' };
    saveChromiumConfig(selection, file);
    const moduleUrl = new URL('../scripts/chromium-config.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {loadChromiumConfig} from ${JSON.stringify(moduleUrl)}; const env = {CHROMIUM_CDP_PORT:'9444'}; loadChromiumConfig(env, process.argv[1]); console.log(JSON.stringify(env));`, file],
      { cwd: dir, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ...selection, CHROMIUM_CDP_PORT: '9444' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('PATH');
  }));

  it('does not persist unrelated environment fields or replace valid data on invalid input', () => sandbox(dir => {
    const file = join(dir, 'browser.json');
    saveChromiumConfig({ CHROMIUM_CDP_PORT: '9223' }, file);
    const before = readFileSync(file, 'utf8');
    expect(() => saveChromiumConfig({ API_TOKEN: 'not-a-browser-setting' }, file)).toThrow('field');
    expect(() => saveChromiumConfig({ CHROMIUM_CDP_PORT: '9223junk' }, file)).toThrow('integer');
    expect(readFileSync(file, 'utf8')).toBe(before);
  }));

  it('fails on corrupt configuration instead of replacing it with defaults', () => sandbox(dir => {
    const file = join(dir, 'browser.json');
    expect(readChromiumConfig(file)).toEqual({});
    writeFileSync(file, '{broken');
    expect(() => loadChromiumConfig({}, file)).toThrow('JSON');
    writeFileSync(file, '{"version":2,"environment":{}}');
    expect(() => loadChromiumConfig({}, file)).toThrow('version 1');
  }));

  it('rejects an explicit missing binary on restart before touching launchd or saved config', () => sandbox(dir => {
    const file = join(dir, 'browser.json');
    saveChromiumConfig({ CHROMIUM_CDP_BINARY: join(dir, 'missing-browser'), CHROMIUM_CDP_PORT: '9223' }, file);
    const before = readFileSync(file, 'utf8');
    const result = spawnSync(process.execPath, [resolve('scripts/launchd.mjs'), 'chromium-cdp', 'restart'], {
      cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', DISCLAUDE_CHROMIUM_CONFIG: file },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CHROMIUM_CDP_BINARY was not found');
    expect(result.stdout).not.toContain('Service unloaded');
    expect(readFileSync(file, 'utf8')).toBe(before);
  }));
});
