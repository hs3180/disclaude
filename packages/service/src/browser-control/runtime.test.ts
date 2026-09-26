import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import nock from 'nock';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrowserCoordinator } from './service.mjs';
import { startBrowserRuntime, type BrowserRuntime } from './runtime.js';

const roots: string[] = [];
const runtimes: BrowserRuntime[] = [];

beforeAll(() => nock.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/u));

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.stop(); }
  for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); }
});

async function cdpEndpoint(statusCode = 200) {
  const server = createHttpServer((_request, response) => {
    response.statusCode = statusCode;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      Browser: 'Chromium/test',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') { throw new Error('Test CDP server did not bind a TCP port'); }
  return { server, port: address.port, endpoint: `http://127.0.0.1:${address.port}` };
}

function makeEnvironment(port: number) {
  const root = mkdtempSync(join(tmpdir(), 'browser-runtime-'));
  roots.push(root);
  const config = join(root, 'chromium-cdp.json');
  writeFileSync(config, JSON.stringify({ version: 1, environment: {
    CHROMIUM_CDP_ADDRESS: '127.0.0.1', CHROMIUM_CDP_PORT: String(port),
  } }));
  return {
    root,
    socket: join(root, 'browser.sock'),
    env: {
      ...process.env,
      DISCLAUDE_BROWSER_SOCKET: join(root, 'browser.sock'),
      DISCLAUDE_CHROMIUM_CONFIG: config,
      // Legacy direct-CDP configuration must not override the deployed service config.
      BU_CDP_URL: 'http://127.0.0.1:1',
    } as NodeJS.ProcessEnv,
  };
}

function mockCoordinator() {
  return {
    holder: null,
    queue: [] as unknown[],
    closed: false,
    close: vi.fn(() => Promise.resolve()),
  };
}

describe('in-process browser coordinator lifecycle', () => {
  it('does nothing when coordinated browser access is not configured', async () => {
    expect(await startBrowserRuntime({})).toBeUndefined();
  });

  it('attaches to the installed CDP, serves the IPC socket in-process, and owns shutdown', async () => {
    const endpoint = await cdpEndpoint();
    const { root, socket, env } = makeEnvironment(endpoint.port);
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const admin = {
      ws: {},
      closed,
      call: vi.fn((method: string) => {
        if (method === 'Target.createTarget') { return Promise.resolve({ targetId: 'test-target' }); }
        return Promise.reject(new Error(`Unexpected CDP method: ${method}`));
      }),
      close: vi.fn(() => { resolveClosed(); return Promise.resolve(); }),
    };
    const coordinator = mockCoordinator() as unknown as import('./coordinator.mjs').Coordinator;
    const connectBrowser = vi.fn((url: string) => {
      expect(url).toBe('ws://127.0.0.1:9222/devtools/browser/test');
      return Promise.resolve(admin);
    });
    let receivedOptions: Record<string, unknown> | undefined;
    const createCoordinator = vi.fn((options: Record<string, unknown>) => {
      receivedOptions = options;
      return coordinator;
    });

    try {
      const runtime = await startBrowserCoordinator({ env, cwd: root, connectBrowser, createCoordinator });
      runtimes.push(runtime);

      expect(runtime.pid).toBe(process.pid);
      expect(runtime.unavailable).toBe(false);
      expect(connectBrowser).toHaveBeenCalledOnce();
      expect(createCoordinator).toHaveBeenCalledOnce();
      expect(receivedOptions).toMatchObject({
        url: 'ws://127.0.0.1:9222/devtools/browser/test',
        target: 'test-target',
        detachedWorker: true,
      });
      expect(existsSync(socket)).toBe(true);
      expect(existsSync(`${socket}.lock`)).toBe(true);

      const launcher = readFileSync(join(root, 'bin', 'browser-use'), 'utf8');
      expect(launcher).toContain('/browser-control/client.mjs');
      expect(launcher).not.toContain('/experiments/');

      const clientModule = await import('./client.mjs');
      const client = await clientModule.connectBrowser(socket);
      await expect(client.request('status')).resolves.toEqual({ state: 'idle', queued: 0 });
      client.close();

      await runtime.stop();
      runtimes.splice(runtimes.indexOf(runtime), 1);
      expect(admin.close).toHaveBeenCalledOnce();
      expect(coordinator.close).toHaveBeenCalledOnce();
      expect(existsSync(socket)).toBe(false);
      expect(existsSync(`${socket}.lock`)).toBe(false);
      expect((await fetch(`${endpoint.endpoint}/json/version`)).ok).toBe(true);
    } finally {
      await new Promise<void>(resolve => endpoint.server.close(() => resolve()));
    }
  });

  it('does not replace an IPC lock owned by a live process', async () => {
    const endpoint = await cdpEndpoint();
    const { socket, env } = makeEnvironment(endpoint.port);
    writeFileSync(`${socket}.lock`, JSON.stringify({ pid: process.pid, instance: 'existing' }));

    try {
      await expect(startBrowserCoordinator({ env })).rejects.toThrow('already owned by process');
      expect(existsSync(socket)).toBe(false);
      expect(JSON.parse(readFileSync(`${socket}.lock`, 'utf8'))).toEqual({ pid: process.pid, instance: 'existing' });
    } finally {
      await new Promise<void>(resolve => endpoint.server.close(() => resolve()));
    }
  });

  it('cleans its lock when the deployed CDP endpoint is unavailable at startup', async () => {
    const endpoint = await cdpEndpoint(503);
    const { socket, env } = makeEnvironment(endpoint.port);
    try {
      await expect(startBrowserCoordinator({ env })).rejects.toThrow('CDP endpoint returned HTTP 503');
      expect(existsSync(socket)).toBe(false);
      expect(existsSync(`${socket}.lock`)).toBe(false);
    } finally {
      await new Promise<void>(resolve => endpoint.server.close(() => resolve()));
    }
  });
});
