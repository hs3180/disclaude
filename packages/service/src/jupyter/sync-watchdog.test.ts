import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatalayerJupyterClient } from '@disclaude/core/jupyter';
import {
  checkTextFileSync,
  listTextFiles,
  runSyncWatchdog,
  sweepTextFileSync,
} from './sync-watchdog.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true });
  }
});

type Entry = {
  type: 'file' | 'directory' | 'notebook';
  path: string;
  content?: string;
  room?: string;
};

/** Fake client with a path-addressable directory tree and RTC text rooms. */
function fixture(tree: Entry[], options: { brokenRooms?: string[] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-sync-watch-')));
  roots.push(root);
  const puts: Array<{ path: string; content: string }> = [];
  const roomsOpened: string[] = [];
  const client = {
    openTextDocument: vi.fn((roomPath: string) => {
      if (options.brokenRooms?.includes(roomPath)) {
        return Promise.reject(new Error(`Room unavailable: ${roomPath}`));
      }
      const entry = tree.find((candidate) => candidate.path === roomPath);
      if (!entry || entry.type !== 'file') {
        return Promise.reject(new Error(`No text room for ${roomPath}`));
      }
      roomsOpened.push(roomPath);
      return Promise.resolve({
        flush: vi.fn(() => Promise.resolve()),
        source: vi.fn(() => entry.room ?? entry.content ?? ''),
        close: vi.fn(),
      });
    }),
    json: vi.fn(
      (route: string, method = 'GET', body?: Record<string, unknown>): Promise<unknown> => {
        const [rawPath, query] = route.split('?');
        const decoded = rawPath
          .replace(/^api\/contents\//, '')
          .split('/')
          .map(decodeURIComponent)
          .join('/');
        if (method === 'PUT') {
          puts.push({ path: decoded, content: String(body?.content) });
          return Promise.resolve({});
        }
        if (query !== 'content=1') {
          throw new Error(`Unexpected listing route ${route}`);
        }
        const children = tree.filter((entry) => {
          const parent = entry.path.includes('/')
            ? entry.path.slice(0, entry.path.lastIndexOf('/'))
            : '';
          return parent === decoded;
        });
        if (
          decoded === '' ||
          tree.some((entry) => entry.type === 'directory' && entry.path === decoded)
        ) {
          return Promise.resolve({
            content: children.map((entry) => ({
              path: entry.path,
              type: entry.type,
              name: entry.path,
            })),
          });
        }
        const file = tree.find((entry) => entry.path === decoded);
        if (file) {
          return Promise.resolve({
            type: 'file',
            format: 'text',
            content: puts.find((put) => put.path === decoded)?.content ?? file.content ?? '',
          });
        }
        throw new Error(`Unexpected remote GET ${route}`);
      }
    ),
  } as unknown as DatalayerJupyterClient;
  const connect = <T>(operation: (client: DatalayerJupyterClient) => Promise<T>) =>
    operation(client);
  return { connect, puts, roomsOpened };
}

describe('checkTextFileSync', () => {
  it('reports in-sync without writing', async () => {
    const { connect, puts } = fixture([{ type: 'file', path: 'script.py', content: 'print(1)\n' }]);
    const result = (await connect((client) => checkTextFileSync(client, 'script.py'))) as {
      status: string;
    };
    expect(result.status).toBe('in-sync');
    expect(puts).toEqual([]);
  });

  it('reports divergence with both hashes and no write by default', async () => {
    const { connect, puts } = fixture([
      { type: 'file', path: 'script.py', content: 'print(1)\n', room: 'print(2)\n' },
    ]);
    const result = (await connect((client) => checkTextFileSync(client, 'script.py'))) as {
      status: string;
      roomSha: string;
      diskSha: string;
      warning: string;
    };
    expect(result.status).toBe('diverged');
    expect(result.roomSha).not.toBe(result.diskSha);
    expect(result.warning).toContain('forceFlush:true');
    expect(puts).toEqual([]);
  });

  it('flushes the room snapshot on forceFlush and verifies it', async () => {
    const { connect, puts } = fixture([
      { type: 'file', path: 'script.py', content: 'print(1)\n', room: 'print(2)\n' },
    ]);
    const result = (await connect((client) =>
      checkTextFileSync(client, 'script.py', { forceFlush: true })
    )) as { status: string; sha: string };
    expect(result.status).toBe('flushed');
    expect(puts).toEqual([{ path: 'script.py', content: 'print(2)\n' }]);
  });

  it('rejects traversal and notebook paths offline', async () => {
    const { connect } = fixture([]);
    await expect(connect((client) => checkTextFileSync(client, '../escape.py'))).rejects.toThrow(
      /traversal/
    );
    await expect(connect((client) => checkTextFileSync(client, 'note.ipynb'))).rejects.toThrow(
      /non-Notebook/
    );
  });
});

describe('listTextFiles', () => {
  it('walks directories, skips notebooks and non-text files, and bounds the walk', async () => {
    const { connect } = fixture([
      { type: 'file', path: 'analysis.py', content: 'x = 1\n' },
      { type: 'file', path: 'data/result.csv', content: 'a,b\n' },
      { type: 'file', path: 'notes/report.md', content: '# notes\n' },
      { type: 'file', path: 'notes/deep/steps.txt', content: 'step\n' },
      { type: 'file', path: 'diagram.png', content: 'binary' },
      { type: 'notebook', path: 'main.ipynb', content: '{}' },
      { type: 'directory', path: 'data' },
      { type: 'directory', path: 'notes' },
      { type: 'directory', path: 'notes/deep' },
    ]);
    const files = await connect((client) => listTextFiles(client, { maxDepth: 4 }));
    expect([...files].sort()).toEqual(['analysis.py', 'notes/deep/steps.txt', 'notes/report.md']);
    const bounded = await connect((client) => listTextFiles(client, { maxFiles: 1 }));
    expect(bounded).toEqual(['analysis.py']);
  });
});

describe('sweepTextFileSync', () => {
  const tree: Entry[] = [
    { type: 'file', path: 'clean.py', content: 'print(1)\n' },
    { type: 'file', path: 'forked.py', content: 'print(1)\n', room: 'print(2)\n' },
    { type: 'file', path: 'broken.py', content: 'print(1)\n' },
  ];

  it('surfaces divergence without writing (warn-only default)', async () => {
    const { connect, puts } = fixture(tree, { brokenRooms: ['broken.py'] });
    const event = await sweepTextFileSync({ connect });
    expect(event.checked).toBe(2);
    expect(event.diverged).toHaveLength(1);
    expect(event.diverged[0]).toMatchObject({ path: 'forked.py', status: 'diverged' });
    expect(event.errors).toEqual([
      { path: 'broken.py', message: expect.stringContaining('Room unavailable') },
    ]);
    expect(puts).toEqual([]);
  });

  it('flushes diverged files when autoFlush is enabled', async () => {
    const { connect, puts } = fixture(tree, { brokenRooms: ['broken.py'] });
    const event = await sweepTextFileSync({ connect, autoFlush: true });
    expect(event.flushed).toHaveLength(1);
    expect(event.flushed[0]).toMatchObject({ path: 'forked.py', status: 'flushed' });
    expect(event.diverged).toEqual([]);
    expect(puts).toEqual([{ path: 'forked.py', content: 'print(2)\n' }]);
  });
});

describe('runSyncWatchdog', () => {
  it('keeps sweeping on the interval until the signal aborts', async () => {
    const { connect } = fixture([
      { type: 'file', path: 'forked.py', content: 'print(1)\n', room: 'print(2)\n' },
    ]);
    const controller = new AbortController();
    const events: number[] = [];
    await runSyncWatchdog({
      connect,
      intervalMs: 60_000,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event.sweep);
        controller.abort();
      },
    });
    expect(events).toEqual([1]);
  });
});
