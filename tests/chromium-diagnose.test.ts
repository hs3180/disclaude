import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  diagnoseChromiumCdp,
  inspectManagedService,
  parseMacServiceState,
  parseSystemdServiceState,
  resolveChromiumStatusConfig,
} from '../scripts/chromium-diagnose.mjs';

const roots: string[] = [];
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'disclaude-chromium-diagnose-'));
  roots.push(path);
  return path;
}

afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('read-only Chromium CDP diagnostics', () => {
  it('resolves environment overrides over the persisted browser selection', () => {
    const root = temporaryDirectory();
    const savedPath = join(root, 'chromium-cdp.json');
    const profilePath = join(root, 'saved-profile');
    mkdirSync(profilePath);
    writeFileSync(savedPath, JSON.stringify({ version: 1, environment: {
      CHROMIUM_CDP_BINARY: '/saved/chrome', CHROMIUM_CDP_PROFILE_DIR: profilePath,
      CHROMIUM_CDP_PORT: '9444',
    } }));

    const config = resolveChromiumStatusConfig({
      home: root,
      platform: 'linux',
      env: { DISCLAUDE_CHROMIUM_CONFIG: savedPath, CHROMIUM_CDP_BINARY: '/env/chrome' },
      exists: path => path === profilePath || path === savedPath,
      executable: path => path === '/env/chrome',
    });

    expect(config).toMatchObject({
      configFile: { path: savedPath, state: 'loaded' },
      executable: { path: '/env/chrome', source: 'environment', available: true },
      profile: { path: profilePath, source: 'chromium-cdp.json', exists: true },
      endpoint: 'http://127.0.0.1:9444',
    });
    expect(config.endpointRequestUrl).toBe('http://127.0.0.1:9444/json/version');
  });

  it('reports malformed persisted configuration without echoing its contents', () => {
    const root = temporaryDirectory();
    const savedPath = join(root, 'chromium-cdp.json');
    writeFileSync(savedPath, '{"token":"must-not-appear"');
    const config = resolveChromiumStatusConfig({
      home: root, platform: 'darwin', env: { DISCLAUDE_CHROMIUM_CONFIG: savedPath },
    });
    expect(config.configFile).toEqual({ path: savedPath, state: 'invalid' });
    expect(JSON.stringify(config)).not.toContain('must-not-appear');
  });

  it('parses launchd and systemd states and marks Docker service state external', () => {
    expect(parseMacServiceState('PID = 391; LastExitStatus = 0;')).toMatchObject({ manager: 'launchd', state: 'running', pid: 391 });
    expect(parseSystemdServiceState('LoadState=loaded\nActiveState=failed\nMainPID=0\n')).toMatchObject({ manager: 'systemd', state: 'failed' });
    expect(parseSystemdServiceState('LoadState=not-found\nActiveState=inactive\n')).toMatchObject({ manager: 'systemd', state: 'not-installed' });
    expect(inspectManagedService({ platform: 'linux', inContainer: true, run: () => { throw new Error('must not query host manager'); } }))
      .toMatchObject({ manager: 'docker', state: 'external' });
  });

  it('probes CDP read-only and avoids host-path claims for a Docker-managed browser', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ Browser: 'Chrome/155.0' }) }));
    const report = await diagnoseChromiumCdp({
      platform: 'linux', inContainer: true,
      env: {
        CHROMIUM_CDP_BINARY: '/usr/bin/chromium',
        CHROMIUM_CDP_PROFILE_DIR: '/data/chromium',
        BU_CDP_URL: 'http://disclaude-chromium:9222',
      },
      executable: () => true,
      exists: () => true,
      run: () => { throw new Error('Docker diagnostics must not query host systemd'); },
      fetchImpl: fetchImpl as typeof fetch,
      runtimeConfiguration: { state: 'loaded', path: '/service/disclaude.config.yaml' },
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe('http://disclaude-chromium:9222/json/version');
    expect(report).toMatchObject({
      executable: { path: '/usr/bin/chromium', available: null, checkedIn: 'docker-container' },
      profile: { path: '/data/chromium', exists: null, checkedIn: 'docker-container' },
      managedService: { manager: 'docker', state: 'external' },
      cdp: { endpoint: 'http://disclaude-chromium:9222', reachable: true, browser: 'Chrome/155.0' },
      cdpReady: null,
      configurationMayDifferFromLoadedService: true,
    });
    expect(JSON.stringify(report)).not.toContain('/json/version');
    expect(report.actions.map(action => action.code)).toContain('docker-service');
  });

  it('only reports a local managed CDP endpoint ready after service ownership is verified', async () => {
    const root = temporaryDirectory();
    const savedPath = join(root, 'chromium-cdp.json');
    const profilePath = join(root, 'profile');
    mkdirSync(profilePath);
    writeFileSync(savedPath, JSON.stringify({ version: 1, environment: { CHROMIUM_CDP_BINARY: '/apps/chrome',
      CHROMIUM_CDP_PROFILE_DIR: profilePath, CHROMIUM_CDP_PORT: '9223' } }));
    const readinessProbe = vi.fn(async (target: { address: string; port: number },
      serviceState: () => { pid?: number }, timeoutMs: number) => {
      expect(target).toEqual({ address: '127.0.0.1', port: 9223 });
      expect(serviceState().pid).toBe(391);
      expect(timeoutMs).toBe(3000);
      return { pid: 391, endpoint: 'http://127.0.0.1:9223', browser: 'Chrome/155.0' };
    });
    const report = await diagnoseChromiumCdp({
      platform: 'darwin', inContainer: false,
      env: { DISCLAUDE_CHROMIUM_CONFIG: savedPath },
      exists: path => path === savedPath || path === profilePath,
      executable: () => true,
      run: () => 'PID = 391; LastExitStatus = 0;',
      fetchImpl: vi.fn(async () => ({ ok: true, json: async () => ({ Browser: 'Chrome/155.0',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/browser/test' }) })) as typeof fetch,
      readinessProbe,
    });

    expect(readinessProbe).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ managedService: { state: 'running', pid: 391 }, cdpReady: true });
    expect(report.actions).toEqual([]);
  });

  it('does not equate a reachable CDP endpoint with managed-service readiness', async () => {
    const root = temporaryDirectory();
    const savedPath = join(root, 'chromium-cdp.json');
    writeFileSync(savedPath, JSON.stringify({ version: 1, environment: { CHROMIUM_CDP_PORT: '9223' } }));
    const report = await diagnoseChromiumCdp({
      platform: 'linux', inContainer: false,
      env: { DISCLAUDE_CHROMIUM_CONFIG: savedPath },
      run: () => 'LoadState=loaded\nActiveState=active\nMainPID=501\n',
      fetchImpl: vi.fn(async () => ({ ok: true, json: async () => ({ Browser: 'Chrome/155.0',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/browser/other' }) })) as typeof fetch,
      readinessProbe: async () => { throw new Error('CDP listener is owned by another process'); },
    });

    expect(report.cdp.reachable).toBe(true);
    expect(report.cdpReady).toBe(false);
    expect(report.actions.map(action => action.code)).toContain('cdp-service-owner');
  });

  it('rejects endpoints with embedded credentials before making a request', async () => {
    const fetchImpl = vi.fn();
    const report = await diagnoseChromiumCdp({
      platform: 'darwin', inContainer: false,
      env: { BU_CDP_URL: 'http://operator:secret@example.test:9222' },
      run: () => 'PID = 0; LastExitStatus = 0;',
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.cdp).toMatchObject({ endpoint: null, reachable: false, result: 'invalid-endpoint' });
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(JSON.stringify(report)).not.toContain('operator');
  });

  it('exposes the cross-platform status and doctor route from the CLI', () => {
    const root = temporaryDirectory();
    const result = execFileSync(process.execPath, [resolve('bin/disclaude.js'), 'chromium-cdp', 'doctor', '--help'], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH || '', HOME: root, XDG_CONFIG_HOME: root, NODE_ENV: 'test' },
      encoding: 'utf8',
    });
    expect(result).toContain('Usage: disclaude chromium-cdp <status|doctor>');
    expect(result).toContain('Read-only');
  });
});
