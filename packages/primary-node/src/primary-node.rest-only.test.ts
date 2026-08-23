/**
 * Tests for PrimaryNode's REST-only serving behavior (Issue #4280, part 5).
 *
 * Part 5 removed the UnixSocketIpcServer lifecycle from PrimaryNode: start()
 * must NOT set the DISCLAUDE_WORKER_IPC_SOCKET env var, must NOT write the
 * IPC socket-path discovery file, and stop() must NOT touch either. MCP
 * tools and push-cli reach PrimaryNode exclusively over the REST API
 * (--api-port / DISCLAUDE_REST_IPC_BASE_URL).
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
import { IPC_SOCKET_PATH_FILE } from '@disclaude/core';

/**
 * Scratch dir proving nothing per-process is created under /tmp either —
 * generateSocketPath() used to mint a per-PID socket file here.
 */
const SCRATCH_DIR = join(tmpdir(), `disclaude-rest-only-test-${process.pid}`);

describe('PrimaryNode REST-only serving (Issue #4280 part 5)', () => {
  beforeEach(() => {
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

  it('stop() completes without an IPC server to stop', async () => {
    const node = new PrimaryNode();
    await node.start();
    await expect(node.stop()).resolves.toBeUndefined();
    expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBeUndefined();
  });
});
