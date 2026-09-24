import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadMigratedBrowserEnv,
  parseSystemdEnvironment,
  prepareLegacyBrowserIpcMigration,
  type LegacyBrowserDefinition,
  type LegacyBrowserMigrationAdapter,
} from './legacy-migration.js';

const homes: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  })));
  for (const home of homes.splice(0)) {rmSync(home, { recursive: true, force: true });}
});

async function fixture() {
  const home = mkdtemp();
  const release = join(home, '.local/share/disclaude/browser-ipc/releases/v1');
  const state = join(home, '.local/state/disclaude/browser-ipc/run');
  const launchAgents = join(home, 'Library/LaunchAgents');
  mkdirSync(release, { recursive: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(launchAgents, { recursive: true });
  const entry = join(release, 'service.mjs');
  writeFileSync(entry, '');
  const file = join(launchAgents, 'com.disclaude.browser-ipc.plist');
  writeFileSync(file, '<plist/>');
  const socket = join(state, 'browser.sock');
  const definition: LegacyBrowserDefinition = {
    platform: 'darwin', label: 'com.disclaude.browser-ipc', file, entry,
    environment: {
      DISCLAUDE_BROWSER_MODE: 'coordinated',
      DISCLAUDE_BROWSER_SOCKET: socket,
      BU_CDP_URL: 'http://127.0.0.1:9223',
      DISCLAUDE_BROWSER_PYTHON: '/opt/browser/python',
      BH_HOME: join(state, 'harness'),
    },
    loaded: true, enabled: true, pid: process.pid, raw: '<plist/>',
  };
  const socketServer = createServer();
  await new Promise<void>((resolve, reject) => {
    socketServer.once('error', reject);
    socketServer.listen(socket, resolve);
  });
  servers.push(socketServer);
  writeFileSync(`${socket}.lock`, JSON.stringify({ pid: process.pid, instance: 'legacy-instance' }), { mode: 0o600 });

  let oldRunning = true;
  const actions = { waitUntilIdle: vi.fn(() => Promise.resolve()), stop: vi.fn(async () => {
    await new Promise<void>(resolve => socketServer.close(() => resolve()));
    oldRunning = false;
  }), restore: vi.fn(async () => {
    oldRunning = true;
    await new Promise<void>((resolve, reject) => {
      socketServer.once('error', reject);
      socketServer.listen(socket, resolve);
    });
    writeFileSync(`${socket}.lock`, JSON.stringify({ pid: process.pid, instance: 'legacy-instance' }), { mode: 0o600 });
  }), commit: vi.fn(() => { rmSync(file); return Promise.resolve(); }),
    isAlive: vi.fn((pid: number) => pid === process.pid && oldRunning),
    ownsProcess: vi.fn((pid: number, actualEntry: string) => pid === process.pid && actualEntry === entry && oldRunning),
  };
  const adapter: LegacyBrowserMigrationAdapter = { inspect: vi.fn(() => definition), ...actions };
  return { home, socket, file, definition, adapter, actions };
}

function mkdtemp(): string {
  const home = mkdtempSync('/tmp/dcm-');
  homes.push(home);
  return home;
}

describe('standalone browser IPC migration', () => {
  it('parses quoted systemd browser settings and rejects EnvironmentFile migration', () => {
    expect(parseSystemdEnvironment([
      '[Unit]',
      'Environment=BH_HOME=/ignored-outside-service',
      '[Service]',
      'Environment="DISCLAUDE_BROWSER_SOCKET=/tmp/browser socket" "BU_CDP_URL=http://127.0.0.1:9222" PATH=/usr/bin',
      "Environment=BH_HOME='/tmp/browser harness'",
    ].join('\n'))).toEqual({
      DISCLAUDE_BROWSER_SOCKET: '/tmp/browser socket',
      BU_CDP_URL: 'http://127.0.0.1:9222',
      BH_HOME: '/tmp/browser harness',
    });
    expect(() => parseSystemdEnvironment('[Service]\n  EnvironmentFile=-/tmp/browser.env'))
      .toThrow('uses EnvironmentFile');
  });

  it('waits for idleness, imports only browser settings, and commits under the service owner', async () => {
    const f = await fixture();
    const env: NodeJS.ProcessEnv = {};
    const migration = await prepareLegacyBrowserIpcMigration(env, { home: f.home, adapter: f.adapter });
    expect(migration).toBeDefined();
    expect(f.actions.waitUntilIdle).toHaveBeenCalledOnce();
    expect(f.actions.stop).toHaveBeenCalledOnce();
    expect(env).toMatchObject({
      DISCLAUDE_BROWSER_MODE: 'coordinated', DISCLAUDE_BROWSER_SOCKET: f.socket,
      BU_CDP_URL: 'http://127.0.0.1:9223', DISCLAUDE_BROWSER_PYTHON: '/opt/browser/python',
    });
    expect(existsSync(f.socket)).toBe(false);
    expect(existsSync(`${f.socket}.lock`)).toBe(false);

    const settings = join(f.home, '.disclaude/browser-ipc.json');
    expect((statSync(settings).mode & 0o777)).toBe(0o600);
    expect(JSON.parse(readFileSync(settings, 'utf8')).environment).toMatchObject({
      DISCLAUDE_BROWSER_MODE: 'coordinated', DISCLAUDE_BROWSER_SOCKET: f.socket,
    });
    await migration!.commit();
    expect(f.actions.commit).toHaveBeenCalledOnce();
    expect(existsSync(f.file)).toBe(false);

    const nextEnv: NodeJS.ProcessEnv = { BU_CDP_URL: 'http://127.0.0.1:9333' };
    loadMigratedBrowserEnv(nextEnv, f.home);
    expect(nextEnv.DISCLAUDE_BROWSER_SOCKET).toBe(f.socket);
    expect(nextEnv.BU_CDP_URL).toBe('http://127.0.0.1:9333');
  });

  it('does not inspect the current user service when migration is explicitly skipped', async () => {
    const f = await fixture();
    const migration = await prepareLegacyBrowserIpcMigration(
      { DISCLAUDE_BROWSER_MIGRATION: 'skip' },
      { home: f.home, adapter: f.adapter },
    );
    expect(migration).toBeUndefined();
    expect(f.adapter.inspect).not.toHaveBeenCalled();
    expect(f.actions.stop).not.toHaveBeenCalled();
    expect(existsSync(f.socket)).toBe(true);
  });

  it('preserves a legacy service when the configured IPC socket belongs to another instance', async () => {
    const f = await fixture();
    await expect(prepareLegacyBrowserIpcMigration(
      { DISCLAUDE_BROWSER_SOCKET: join(f.home, 'another-instance.sock') },
      { home: f.home, adapter: f.adapter },
    )).rejects.toThrow('different socket');
    expect(f.actions.stop).not.toHaveBeenCalled();
    expect(existsSync(f.file)).toBe(true);
    expect(existsSync(f.socket)).toBe(true);
  });

  it('rolls the legacy unit and settings back when the new service fails', async () => {
    const f = await fixture();
    const env: NodeJS.ProcessEnv = {};
    const migration = await prepareLegacyBrowserIpcMigration(env, { home: f.home, adapter: f.adapter });
    await migration!.rollback();
    expect(f.actions.restore).toHaveBeenCalledOnce();
    expect(existsSync(f.file)).toBe(true);
    expect(existsSync(f.socket)).toBe(true);
    expect(existsSync(`${f.socket}.lock`)).toBe(true);
    expect(existsSync(join(f.home, '.disclaude/browser-ipc.json'))).toBe(false);
    expect(env.DISCLAUDE_BROWSER_SOCKET).toBeUndefined();
  });

  it('does not stop or reload a broker when it has active work', async () => {
    const f = await fixture();
    f.actions.waitUntilIdle.mockRejectedValue(new Error('busy queue'));
    const env: NodeJS.ProcessEnv = {};
    await expect(prepareLegacyBrowserIpcMigration(env, { home: f.home, adapter: f.adapter })).rejects.toThrow('busy queue');
    expect(f.actions.stop).not.toHaveBeenCalled();
    expect(f.actions.restore).not.toHaveBeenCalled();
    expect(existsSync(f.socket)).toBe(true);
    expect(existsSync(join(f.home, '.disclaude/browser-ipc.json'))).toBe(false);
    expect(env.DISCLAUDE_BROWSER_SOCKET).toBeUndefined();
  });

  it('preserves a legacy service when the main configuration explicitly disables coordinated mode', async () => {
    const f = await fixture();
    const env: NodeJS.ProcessEnv = {
      DISCLAUDE_BROWSER_MODE: 'disabled',
      DISCLAUDE_BROWSER_SOCKET: f.socket,
      BU_CDP_URL: 'http://127.0.0.1:9223',
    };
    await expect(prepareLegacyBrowserIpcMigration(env, { home: f.home, adapter: f.adapter })).rejects.toThrow('disables coordinated browser mode');
    expect(f.actions.stop).not.toHaveBeenCalled();
    expect(existsSync(f.file)).toBe(true);
    expect(existsSync(f.socket)).toBe(true);
  });

  it('refuses to stop a live service when its manager PID does not own the broker entry', async () => {
    const f = await fixture();
    f.actions.ownsProcess.mockReturnValue(false);
    await expect(prepareLegacyBrowserIpcMigration({}, { home: f.home, adapter: f.adapter }))
      .rejects.toThrow('PID does not match its managed entry');
    expect(f.actions.stop).not.toHaveBeenCalled();
    expect(existsSync(f.socket)).toBe(true);
  });

  it('retires a loaded but crashed job with a dead, owned lock without probing a stale socket', async () => {
    const f = await fixture();
    f.definition.pid = undefined;
    writeFileSync(`${f.socket}.lock`, JSON.stringify({ pid: 99999999, instance: 'legacy-instance' }), { mode: 0o600 });
    const migration = await prepareLegacyBrowserIpcMigration({}, { home: f.home, adapter: f.adapter });
    expect(f.actions.waitUntilIdle).not.toHaveBeenCalled();
    expect(f.actions.stop).toHaveBeenCalledOnce();
    await migration!.commit();
    expect(existsSync(f.file)).toBe(false);
    expect(existsSync(`${f.socket}.lock`)).toBe(false);
  });

  it('does not follow a symlinked settings directory or stop the legacy service', async () => {
    const f = await fixture();
    const elsewhere = join(f.home, 'outside-settings');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(f.home, '.disclaude'));
    await expect(prepareLegacyBrowserIpcMigration({}, { home: f.home, adapter: f.adapter }))
      .rejects.toThrow('must be a regular directory');
    expect(f.actions.stop).not.toHaveBeenCalled();
    expect(existsSync(f.file)).toBe(true);
    expect(existsSync(f.socket)).toBe(true);
  });
});
