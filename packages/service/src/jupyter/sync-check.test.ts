import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatalayerJupyterClient } from '@disclaude/core/jupyter';
import type { ToolContext } from '@disclaude/core';
import { NotebookTools, type NotebookToolOptions } from './notebook-tools.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true });
  }
});
const invocation: ToolContext = { signal: new AbortController().signal };
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const roomRoute = 'api/contents/script.py?content=1';
const putRoute = 'api/contents/script.py';

/** Fake client plus a path-addressable RTC text room, mirroring notebook-tools fixtures. */
async function fixture(options: {
  diskContent?: string;
  roomContent?: string;
  diskFormat?: string;
}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-sync-check-')));
  roots.push(root);
  const roomContent = options.roomContent ?? options.diskContent ?? 'print(1)\n';
  const room = {
    flush: vi.fn(() => Promise.resolve()),
    source: vi.fn(() => roomContent),
    close: vi.fn(),
  };
  const contents = new Map<string, { type: string; format: string; content: string }>([
    [roomRoute, { type: 'file', format: options.diskFormat ?? 'text', content: options.diskContent ?? 'print(1)\n' }],
  ]);
  const puts: Array<{ route: string; body: Record<string, unknown> | undefined }> = [];
  const client = {
    openTextDocument: vi.fn(() => Promise.resolve(room)),
    json: vi.fn(
      (route: string, method = 'GET', body?: Record<string, unknown>): Promise<unknown> => {
        if (method === 'GET') {
          const stored = contents.get(route);
          if (!stored) {
            throw new Error(`Unexpected remote GET ${route}`);
          }
          return Promise.resolve({ ...stored });
        }
        if (method === 'PUT') {
          puts.push({ route, body });
          contents.set(`${route}?content=1`, {
            type: 'file',
            format: 'text',
            content: String(body?.content),
          });
          return Promise.resolve({});
        }
        throw new Error('Unexpected remote API operation');
      }
    ),
  };
  const connect = <T>(operation: (value: DatalayerJupyterClient) => Promise<T>): Promise<T> =>
    operation(client as unknown as DatalayerJupyterClient);
  const session = new NotebookTools({
    projectDir: root,
    useClient: () => {
      throw new Error('sync-check must not resolve a notebook reference');
    },
    connect,
  } satisfies NotebookToolOptions);
  const call = (name: string, input: Record<string, unknown>) =>
    session.tools.find((t) => t.name === name)!.execute(input, invocation);
  return { root, room, client, contents, puts, session, call };
}

describe('notebook_sync_check', () => {
  it('reports in-sync without any write and closes the room', async () => {
    const f = await fixture({ diskContent: 'print(1)\n' });
    await expect(f.call('notebook_sync_check', { path: 'script.py' })).resolves.toEqual({
      status: 'in-sync',
      path: 'script.py',
      sha: hash('print(1)\n'),
      roomBytes: Buffer.byteLength('print(1)\n', 'utf8'),
      diskBytes: Buffer.byteLength('print(1)\n', 'utf8'),
    });
    expect(f.client.openTextDocument).toHaveBeenCalledExactlyOnceWith('script.py');
    expect(f.puts).toEqual([]);
    expect(f.room.flush).toHaveBeenCalledOnce();
    expect(f.room.close).toHaveBeenCalledOnce();
  });

  it('reports diverged with both hashes and never PUTs by default', async () => {
    const f = await fixture({ diskContent: 'print(1)\n', roomContent: 'print(2)\n' });
    const result = (await f.call('notebook_sync_check', { path: 'script.py' })) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      status: 'diverged',
      path: 'script.py',
      roomSha: hash('print(2)\n'),
      diskSha: hash('print(1)\n'),
      roomBytes: Buffer.byteLength('print(2)\n', 'utf8'),
      diskBytes: Buffer.byteLength('print(1)\n', 'utf8'),
    });
    expect(String(result.warning)).toContain('disk bytes');
    expect(String(result.warning)).toContain('60s');
    expect(String(result.warning)).toContain('forceFlush');
    expect(f.puts).toEqual([]);
    expect(f.room.close).toHaveBeenCalledOnce();
  });

  it('forceFlush PUTs the room snapshot and re-verifies by re-reading disk', async () => {
    const f = await fixture({ diskContent: 'print(1)\n', roomContent: 'print(2)\n' });
    const result = (await f.call('notebook_sync_check', {
      path: 'script.py',
      forceFlush: true,
    })) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: 'flushed',
      path: 'script.py',
      sha: hash('print(2)\n'),
      roomBytes: Buffer.byteLength('print(2)\n', 'utf8'),
      diskBytes: Buffer.byteLength('print(2)\n', 'utf8'),
    });
    expect(f.puts).toEqual([
      { route: putRoute, body: { type: 'file', format: 'text', content: 'print(2)\n' } },
    ]);
    // GET (compare), PUT (snapshot), GET (re-verify) — exactly three remote calls;
    // reads pass no method argument (default GET).
    expect(f.client.json.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [roomRoute, undefined],
      [putRoute, 'PUT'],
      [roomRoute, undefined],
    ]);
    expect(f.room.close).toHaveBeenCalledOnce();
  });

  it('does not PUT when already in-sync even with forceFlush', async () => {
    const f = await fixture({ diskContent: 'print(1)\n' });
    await expect(
      f.call('notebook_sync_check', { path: 'script.py', forceFlush: true })
    ).resolves.toMatchObject({ status: 'in-sync' });
    expect(f.puts).toEqual([]);
  });

  it('reports unsupported-binary instead of misreading base64 disk format', async () => {
    const f = await fixture({ diskContent: 'cHJpbnQoMSkK', diskFormat: 'base64' });
    await expect(f.call('notebook_sync_check', { path: 'script.py' })).resolves.toEqual({
      status: 'unsupported-binary',
      path: 'script.py',
    });
    expect(f.puts).toEqual([]);
    expect(f.room.close).toHaveBeenCalledOnce();
  });

  it('rejects traversal, absolute, backslash and .ipynb paths before any remote call', async () => {
    const f = await fixture({ diskContent: 'print(1)\n' });
    for (const invalid of ['/abs', '../x', 'a\\b', 'x/../../y', 'n.ipynb', '']) {
      await expect(f.call('notebook_sync_check', { path: invalid })).rejects.toThrow(
        /Text file requires a relative/
      );
    }
    expect(f.client.openTextDocument).not.toHaveBeenCalled();
    expect(f.client.json).not.toHaveBeenCalled();
    expect(f.room.close).not.toHaveBeenCalled();
  });
});
