import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DshStdioTransport } from './dsh-transport.js';

async function fakeDsh(): Promise<{ dir: string; binary: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-transport-'));
  const binary = join(dir, 'dsh');
  await writeFile(
    binary,
    `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'notify-me') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { ok: true } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'notified' }) + '\\n');
    return;
  }
  if (request.method === 'rpc-error') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'fixture failure' } }) + '\\n');
    return;
  }
  if (request.method === 'invalid-json') {
    process.stdout.write('not-json\\n');
    return;
  }
  if (request.method === 'exit') {
    process.exit(7);
  }
  const delay = request.method === 'slow' ? 80 : request.method === 'first' ? 30 : 0;
  setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method }) + '\\n'), delay);
});
`,
    { mode: 0o755 }
  );
  return { dir, binary };
}

describe('DshStdioTransport', () => {
  it('correlates out-of-order responses and delivers notifications', async () => {
    const fixture = await fakeDsh();
    const notifications: unknown[] = [];
    const transport = new DshStdioTransport({
      binary: fixture.binary,
      onNotification: (message) => notifications.push(message),
    });
    try {
      const first = transport.request('first');
      const second = transport.request('second');
      await expect(first).resolves.toBe('first');
      await expect(second).resolves.toBe('second');
      await expect(transport.request('notify-me')).resolves.toBe('notified');
      expect(notifications).toEqual([{ jsonrpc: '2.0', method: 'event', params: { ok: true } }]);
    } finally {
      transport.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects a request on timeout and supports explicit close', async () => {
    const fixture = await fakeDsh();
    const transport = new DshStdioTransport({ binary: fixture.binary, requestTimeoutMs: 10 });
    try {
      await expect(transport.request('slow')).rejects.toThrow('timed out: slow');
      transport.close();
      expect(() => transport.start()).toThrow('transport is closed');
    } finally {
      transport.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('cancels one request without closing the reusable transport', async () => {
    const fixture = await fakeDsh();
    const transport = new DshStdioTransport({ binary: fixture.binary });
    const controller = new AbortController();
    try {
      const cancelled = transport.request('slow', undefined, controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toThrow('dsh request cancelled: slow');
      await expect(transport.request('after-cancel')).resolves.toBe('after-cancel');
    } finally {
      transport.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('surfaces RPC errors and reports malformed protocol frames', async () => {
    const fixture = await fakeDsh();
    const protocolErrors: string[] = [];
    const transport = new DshStdioTransport({
      binary: fixture.binary,
      onProtocolError: (error) => protocolErrors.push(error.message),
      requestTimeoutMs: 200,
    });
    try {
      await expect(transport.request('rpc-error')).rejects.toThrow(
        'dsh RPC error -32001: fixture failure'
      );
      await expect(transport.request('invalid-json')).rejects.toThrow('timed out: invalid-json');
      expect(protocolErrors).toEqual(['dsh emitted invalid JSON']);
    } finally {
      transport.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects pending requests when the dsh process exits early', async () => {
    const fixture = await fakeDsh();
    const transport = new DshStdioTransport({ binary: fixture.binary });
    try {
      await expect(transport.request('exit')).rejects.toThrow(
        'dsh process exited before completion (code=7, signal=none)'
      );
    } finally {
      transport.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
});
