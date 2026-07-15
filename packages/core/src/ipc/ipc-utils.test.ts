/**
 * Tests for ipc-utils — getIpcSocketPath fallback chain + getIpcClient lifecycle.
 *
 * Canonical home for the ipc-utils module tests. getIpcSocketPath / getIpcClient /
 * resetIpcClient coverage used to live at the bottom of unix-socket-client.test.ts
 * (Issue #1617); it is co-located with the module here (Issue #4129), and the
 * migrated blocks were removed from that file to avoid duplication.
 *
 * Covers:
 * - getIpcSocketPath: full 5-level fallback chain
 *     override > DISCLAUDE_WORKER_IPC_SOCKET > DISCLAUDE_IPC_SOCKET_PATH
 *     > IPC_SOCKET_PATH_FILE (#3808) > DEFAULT_IPC_CONFIG.socketPath
 *   including stale-PID detection in the file fallback.
 * - getIpcClient: singleton + transport selection (UnixSocketIpcClient default vs
 *   RestIpcClient when DISCLAUDE_REST_IPC_ENABLED=true, #4279 Phase 2).
 * - resetIpcClient: instance invalidation.
 *
 * The singleton is module-level state; resetIpcClient() clears it between tests,
 * so static imports are safe — env vars are read at call time, not import time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import {
  UnixSocketIpcClient,
  RestIpcClient,
  getIpcSocketPath,
  getIpcClient,
  resetIpcClient,
} from './index.js';
import { DEFAULT_IPC_CONFIG, IPC_SOCKET_PATH_FILE } from './protocol.js';

const SOCKET_ENV_KEYS = ['DISCLAUDE_WORKER_IPC_SOCKET', 'DISCLAUDE_IPC_SOCKET_PATH'] as const;
const REST_ENV_KEYS = [
  'DISCLAUDE_REST_IPC_ENABLED',
  'DISCLAUDE_REST_IPC_BASE_URL',
  'DISCLAUDE_REST_IPC_API_TOKEN',
] as const;

// A PID above the kernel's pid_max ceiling (4194304 on 64-bit Linux) is guaranteed
// not to be running, so isProcessRunning() returns false (stale) deterministically.
const STALE_PID = 4_200_000;

describe('getIpcSocketPath', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let fileExisted = false;
  let savedFileContent: string | null = null;

  beforeEach(() => {
    for (const k of SOCKET_ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    // Defensive cleanup (Issue #4061): IPC_SOCKET_PATH_FILE is a shared real path
    // (/tmp/disclaude-ipc-socket). Snapshot + remove it so the default/no-file path
    // is deterministic and cannot leak between tests or across test files.
    fileExisted = existsSync(IPC_SOCKET_PATH_FILE);
    savedFileContent = fileExisted ? readFileSync(IPC_SOCKET_PATH_FILE, 'utf-8') : null;
    try { unlinkSync(IPC_SOCKET_PATH_FILE); } catch { /* ignore if not exists */ }
  });

  afterEach(() => {
    for (const k of SOCKET_ENV_KEYS) {
      if (savedEnv[k] !== undefined) { process.env[k] = savedEnv[k]; }
      else { delete process.env[k]; }
    }
    // Restore (or remove) the file to its pre-test state.
    if (fileExisted && savedFileContent !== null) {
      writeFileSync(IPC_SOCKET_PATH_FILE, savedFileContent);
    } else {
      try { unlinkSync(IPC_SOCKET_PATH_FILE); } catch { /* ignore */ }
    }
  });

  it('uses the override parameter (highest priority)', () => {
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = '/tmp/env.sock';
    expect(getIpcSocketPath({ override: '/custom/override.sock' })).toBe('/custom/override.sock');
  });

  it('uses DISCLAUDE_WORKER_IPC_SOCKET env var', () => {
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = '/tmp/worker.sock';
    expect(getIpcSocketPath()).toBe('/tmp/worker.sock');
  });

  it('uses DISCLAUDE_IPC_SOCKET_PATH as fallback env var', () => {
    process.env.DISCLAUDE_IPC_SOCKET_PATH = '/tmp/manual.sock';
    expect(getIpcSocketPath()).toBe('/tmp/manual.sock');
  });

  it('prioritizes DISCLAUDE_WORKER_IPC_SOCKET over DISCLAUDE_IPC_SOCKET_PATH', () => {
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = '/tmp/worker.sock';
    process.env.DISCLAUDE_IPC_SOCKET_PATH = '/tmp/manual.sock';
    expect(getIpcSocketPath()).toBe('/tmp/worker.sock');
  });

  it('reads IPC_SOCKET_PATH_FILE when no env vars are set (Issue #3808)', () => {
    const fileSocketPath = '/tmp/ipc-utils-test-from-file.sock';
    // File format: "<socketPath>\n<PID>" — a live PID (this process) keeps it fresh.
    writeFileSync(IPC_SOCKET_PATH_FILE, `${fileSocketPath}\n${process.pid}`);
    expect(getIpcSocketPath()).toBe(fileSocketPath);
  });

  it('falls through to default when the file PID is stale (Issue #3808)', () => {
    writeFileSync(IPC_SOCKET_PATH_FILE, `/tmp/ipc-utils-stale.sock\n${STALE_PID}`);
    expect(getIpcSocketPath()).toBe(DEFAULT_IPC_CONFIG.socketPath);
  });

  it('returns the default path when no env vars, override, or file exist', () => {
    // IPC_SOCKET_PATH_FILE already removed in beforeEach (Issue #4061).
    expect(getIpcSocketPath()).toBe(DEFAULT_IPC_CONFIG.socketPath);
  });
});

describe('getIpcClient transport selection + singleton', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [...SOCKET_ENV_KEYS, ...REST_ENV_KEYS]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of [...SOCKET_ENV_KEYS, ...REST_ENV_KEYS]) {
      if (savedEnv[k] !== undefined) { process.env[k] = savedEnv[k]; }
      else { delete process.env[k]; }
    }
    resetIpcClient();
  });

  it('returns a UnixSocketIpcClient by default (REST disabled)', () => {
    const client = getIpcClient();
    expect(client).toBeInstanceOf(UnixSocketIpcClient);
  });

  it('returns a RestIpcClient when DISCLAUDE_REST_IPC_ENABLED=true (#4279)', () => {
    process.env.DISCLAUDE_REST_IPC_ENABLED = 'true';
    const client = getIpcClient();
    expect(client).toBeInstanceOf(RestIpcClient);
  });

  it('returns the same instance on repeated calls (singleton)', () => {
    const a = getIpcClient();
    const b = getIpcClient();
    expect(a).toBe(b);
  });

  it('creates a new instance after resetIpcClient', () => {
    const first = getIpcClient();
    resetIpcClient();
    const second = getIpcClient();
    expect(second).not.toBe(first);
  });
});

// Config passthrough is verified in isolation with a mocked RestIpcClient so the
// env-derived baseUrl/apiToken can be inspected (they are private on the real class).
describe('getIpcClient REST config passthrough (#4279)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const k of REST_ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(() => {
    vi.doUnmock('./rest-ipc-client.js');
    vi.resetModules();
    for (const k of REST_ENV_KEYS) {
      if (savedEnv[k] !== undefined) { process.env[k] = savedEnv[k]; }
      else { delete process.env[k]; }
    }
  });

  it('passes DISCLAUDE_REST_IPC_BASE_URL + API_TOKEN to RestIpcClient', async () => {
    const ctor = vi.fn();
    vi.doMock('./rest-ipc-client.js', () => ({ RestIpcClient: ctor }));
    process.env.DISCLAUDE_REST_IPC_ENABLED = 'true';
    process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://1.2.3.4:9999/';
    process.env.DISCLAUDE_REST_IPC_API_TOKEN = 'secret-token';
    const { getIpcClient } = await import('./ipc-utils.js');
    getIpcClient();
    expect(ctor).toHaveBeenCalledWith({ baseUrl: 'http://1.2.3.4:9999/', apiToken: 'secret-token' });
  });

  it('defaults baseUrl to http://localhost:9200 + undefined token when env unset', async () => {
    const ctor = vi.fn();
    vi.doMock('./rest-ipc-client.js', () => ({ RestIpcClient: ctor }));
    process.env.DISCLAUDE_REST_IPC_ENABLED = 'true';
    delete process.env.DISCLAUDE_REST_IPC_BASE_URL;
    delete process.env.DISCLAUDE_REST_IPC_API_TOKEN;
    const { getIpcClient } = await import('./ipc-utils.js');
    getIpcClient();
    expect(ctor).toHaveBeenCalledWith({ baseUrl: 'http://localhost:9200', apiToken: undefined });
  });
});
