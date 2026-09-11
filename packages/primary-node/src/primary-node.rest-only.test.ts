/**
 * Tests for PrimaryNode's REST-only serving behavior (Issue #4280, part 5).
 *
 * Part 5 removed the UnixSocketIpcServer lifecycle from PrimaryNode: start()
 * must NOT set the DISCLAUDE_WORKER_IPC_SOCKET env var, must NOT write the
 * IPC socket-path discovery file, and stop() must NOT touch either. MCP
 * tools and push-cli reach PrimaryNode exclusively over the REST API
 * (--api-port / DISCLAUDE_API_BASE_URL).
 *
 * These tests pin that removal: any regression that reintroduces the IPC
 * server into start() (e.g. re-adding startIpcServer()) fails here even
 * though the Unix-socket classes still exist in @disclaude/core (their
 * removal is the final part of #4280).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrimaryNode } from './primary-node.js';
import { createServer } from 'node:http';
import { once } from 'node:events';

const backend = vi.hoisted(() => ({
  selected: 'claude' as string | undefined,
  select: vi.fn(),
  info: vi.fn(() => ({ available: true, unavailableReason: undefined as string | undefined })),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    Config: class extends actual.Config {
      static get AGENT_BACKEND() { return backend.selected as typeof actual.Config.AGENT_BACKEND; }
    },
    setDefaultProvider: backend.select,
    getProvider: () => ({ getInfo: backend.info }),
  };
});

/**
 * The socket-path discovery file the IPC server used to write (Issue #3808).
 * Issue #4168 (Phase 3 residual) removed IPC_SOCKET_PATH_FILE from
 * @disclaude/core with the transport; the well-known path is pinned here
 * because a stale file from an older deployment may still exist on the host —
 * the test below asserts start() never (re)writes it.
 */
const IPC_SOCKET_PATH_FILE = join(tmpdir(), 'disclaude-ipc-socket');

/**
 * Scratch dir proving nothing per-process is created under /tmp either —
 * generateSocketPath() used to mint a per-PID socket file here.
 */
const SCRATCH_DIR = join(tmpdir(), `disclaude-rest-only-test-${process.pid}`);

describe('PrimaryNode REST-only serving (Issue #4280 part 5)', () => {
  beforeEach(() => {
    backend.selected = 'claude';
    backend.select.mockReset();
    backend.info.mockReset().mockReturnValue({ available: true, unavailableReason: undefined });
    vi.resetModules();
    // initScheduler is non-fatal in start() (Issue #3361) but touches the real
    // workspace/cooldown dirs — stub it out; this test is only about the IPC
    // lifecycle that used to run alongside it.
    vi.spyOn(PrimaryNode.prototype, <never>'initScheduler').mockResolvedValue(undefined);
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;
  });

  it('rejects a missing backend before starting the scheduler', async () => {
    backend.selected = undefined;
    await expect(new PrimaryNode().start()).rejects.toThrow('No agent backend configured');
    expect(backend.select).not.toHaveBeenCalled();
    expect(backend.info).not.toHaveBeenCalled();
  });

  it('propagates backend selection failure without switching to Claude', async () => {
    backend.selected = 'unknown';
    backend.select.mockImplementation(() => { throw new Error('Unknown provider type: unknown'); });
    await expect(new PrimaryNode().start()).rejects.toThrow('Unknown provider type: unknown');
    expect(backend.select).toHaveBeenCalledExactlyOnceWith('unknown');
    expect(backend.info).not.toHaveBeenCalled();
  });

  it('rejects an unavailable backend before starting the scheduler', async () => {
    backend.selected = 'codex';
    backend.info.mockReturnValue({ available: false, unavailableReason: 'Codex login required' });
    await expect(new PrimaryNode().start()).rejects.toThrow('Codex login required');
    expect(backend.select).toHaveBeenCalledExactlyOnceWith('codex');
  });

  it('start() does not set DISCLAUDE_WORKER_IPC_SOCKET', async () => {
    const node = new PrimaryNode();
    await node.start();

    // The env var used to be set by startIpcServer() for MCP child processes.
    expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBeUndefined();

    await node.stop();
  });

  it('start() does not write the IPC socket-path discovery file', async () => {
    const node = new PrimaryNode();
    await node.start();

    // The discovery file (/tmp/disclaude-ipc-socket by default) used to be
    // written by startIpcServer() for external CLI consumers (Issue #3808).
    // A stale file from an older deployment may exist on the host, so assert
    // on write *behavior* instead of absence: snapshot mtime across start().
    const statBefore = existsSync(IPC_SOCKET_PATH_FILE)
      ? statSync(IPC_SOCKET_PATH_FILE).mtimeMs
      : -1;
    const nodeLate = new PrimaryNode();
    await nodeLate.start();
    const statAfter = existsSync(IPC_SOCKET_PATH_FILE)
      ? statSync(IPC_SOCKET_PATH_FILE).mtimeMs
      : -1;
    expect(statAfter).toBe(statBefore);

    await node.stop();
    await nodeLate.stop();
  });

  it('defers cron initialization until the real REST listener is ready, exactly once', async () => {
    const node = new PrimaryNode();
    const init = vi.spyOn(PrimaryNode.prototype as unknown as { initScheduler(): Promise<void> }, 'initScheduler');
    const server = createServer((_req, res) => res.end('ready'));
    try {
      await node.start({ deferScheduler: true });
      expect(init).not.toHaveBeenCalled();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') { throw new Error('Expected TCP address'); }
      init.mockImplementation(async () => {
        const result = await fetch(`http://127.0.0.1:${address.port}`);
        expect(await result.text()).toBe('ready');
      });
      await Promise.all([node.startDeferredScheduler(), node.startDeferredScheduler()]);
      expect(init).toHaveBeenCalledTimes(1);
    } finally {
      await node.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('never starts a deferred scheduler after shutdown or before node startup', async () => {
    const node = new PrimaryNode();
    const init = vi.spyOn(PrimaryNode.prototype as unknown as { initScheduler(): Promise<void> }, 'initScheduler');
    await node.startDeferredScheduler();
    await node.start({ deferScheduler: true });
    await node.stop();
    await node.startDeferredScheduler();
    expect(init).not.toHaveBeenCalled();
  });

  it('keeps deferred scheduler initialization failure non-fatal', async () => {
    const node = new PrimaryNode();
    vi.spyOn(PrimaryNode.prototype as unknown as { initScheduler(): Promise<void> }, 'initScheduler').mockRejectedValue(new Error('fixture failure'));
    await node.start({ deferScheduler: true });
    await expect(node.startDeferredScheduler()).resolves.toBeUndefined();
    await node.stop();
  });

  it('stop() completes without an IPC server to stop', async () => {
    const node = new PrimaryNode();
    await node.start();
    await expect(node.stop()).resolves.toBeUndefined();
    expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBeUndefined();
  });
});
