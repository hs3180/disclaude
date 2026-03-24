/**
 * Virtual filesystem mock for unit tests.
 *
 * Provides an in-memory Map-based filesystem that replaces all `fs` operations.
 * Tests using this mock have zero side effects on the real filesystem.
 *
 * @module channels/mock-fs
 */

import { vi } from 'vitest';

/** Virtual filesystem: path → content (null = directory, string = file) */
const vfs = new Map<string, string | null>();

/** Normalize path: forward slashes, no trailing slash */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Reset the virtual filesystem */
function resetVfs(): void {
  vfs.clear();
}

const mockFs = {
  existsSync: vi.fn((p: string): boolean => vfs.has(norm(p))),

  mkdirSync: vi.fn((p: string, opts?: { recursive?: boolean }): void => {
    const np = norm(p);
    if (!opts?.recursive) {
      if (vfs.has(np)) {
        const err: NodeJS.ErrnoException = new Error(`EEXIST: file already exists, mkdir '${p}'`) as any;
        err.code = 'EEXIST';
        throw err;
      }
      vfs.set(np, null);
      return;
    }
    // recursive: ensure all intermediate directories exist
    const parts = np.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      if (!vfs.has(cur)) vfs.set(cur, null);
    }
  }),

  writeFileSync: vi.fn((p: string, content: string): void => {
    vfs.set(norm(p), String(content));
  }),

  readFileSync: vi.fn((p: string, _encoding?: string): string => {
    const np = norm(p);
    if (!vfs.has(np)) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${p}'`) as any;
      err.code = 'ENOENT';
      throw err;
    }
    const val = vfs.get(np);
    if (val === null) {
      const err: NodeJS.ErrnoException = new Error(`EISDIR: illegal operation on a directory, read`) as any;
      err.code = 'EISDIR';
      throw err;
    }
    return val;
  }),

  readdirSync: vi.fn((p: string, opts?: { withFileTypes?: boolean }): any[] => {
    const np = norm(p);
    if (!vfs.has(np) || vfs.get(np) !== null) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, scandir '${p}'`) as any;
      err.code = 'ENOENT';
      throw err;
    }
    const prefix = np + '/';
    const seen = new Map<string, boolean>();
    for (const key of vfs.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (name && !seen.has(name)) {
          seen.set(name, vfs.get(prefix + name) === null);
        }
      }
    }
    if (opts?.withFileTypes) {
      return Array.from(seen.entries()).map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
    }
    return Array.from(seen.keys());
  }),

  rmSync: vi.fn((p: string, opts?: { recursive?: boolean; force?: boolean }): void => {
    const np = norm(p);
    if (!vfs.has(np)) {
      if (opts?.force) return;
      const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, rm '${p}'`) as any;
      err.code = 'ENOENT';
      throw err;
    }
    if (opts?.recursive) {
      const prefix = np + '/';
      for (const key of [...vfs.keys()]) {
        if (key === np || key.startsWith(prefix)) vfs.delete(key);
      }
    } else {
      vfs.delete(np);
    }
  }),

  renameSync: vi.fn((oldP: string, newP: string): void => {
    const onp = norm(oldP);
    const nnp = norm(newP);
    if (!vfs.has(onp)) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, rename`) as any;
      err.code = 'ENOENT';
      throw err;
    }
    vfs.set(nnp, vfs.get(onp)!);
    vfs.delete(onp);
    if (vfs.get(nnp) === null) {
      const oldPrefix = onp + '/';
      const newPrefix = nnp + '/';
      for (const key of [...vfs.keys()]) {
        if (key.startsWith(oldPrefix)) {
          vfs.set(newPrefix + key.slice(oldPrefix.length), vfs.get(key)!);
          vfs.delete(key);
        }
      }
    }
  }),

  chmodSync: vi.fn((): void => {}),
};

export { mockFs, resetVfs };
