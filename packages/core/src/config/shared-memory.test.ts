import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SharedMemory, createSharedMemory } from './shared-memory.js';
import type { SharedMemoryData } from './shared-memory.js';

describe('SharedMemory', () => {
  let tmpDir: string;
  let mem: SharedMemory;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-memory-test-'));
    mem = new SharedMemory(tmpDir);
  });

  afterEach(() => {
    mem.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Construction ─────────────────────────────────────────────────────

  describe('construction', () => {
    it('creates a new SharedMemory instance', () => {
      expect(mem).toBeInstanceOf(SharedMemory);
    });

    it('returns empty data for fresh workspace', () => {
      expect(mem.getSnapshot()).toEqual({});
    });

    it('loads existing data from disk', () => {
      const data: SharedMemoryData = {
        _meta: {
          version: 1,
          lastModified: new Date().toISOString(),
          lastWriter: 'test',
        },
        namespaces: {
          auth: {
            github: {
              _value: { token: 'ghs_test' },
              _updatedAt: Date.now(),
              _updatedBy: 'test',
            },
          },
        },
      };
      fs.writeFileSync(
        path.join(tmpDir, '.shared-memory.json'),
        JSON.stringify(data, null, 2)
      );

      const mem2 = new SharedMemory(tmpDir);
      expect(mem2.get('auth', 'github')).toEqual({ token: 'ghs_test' });
      mem2.dispose();
    });

    it('handles corrupted file gracefully', () => {
      fs.writeFileSync(path.join(tmpDir, '.shared-memory.json'), 'not json');
      const mem2 = new SharedMemory(tmpDir);
      expect(mem2.getSnapshot()).toEqual({});
      mem2.dispose();
    });
  });

  // ─── get / set / delete ──────────────────────────────────────────────

  describe('get', () => {
    it('returns undefined for non-existent namespace', () => {
      expect(mem.get('nonexistent', 'key')).toBeUndefined();
    });

    it('returns undefined for non-existent key', () => {
      mem.set('auth', 'github', { token: 'test' });
      expect(mem.get('auth', 'nonexistent')).toBeUndefined();
    });

    it('returns stored primitive value', () => {
      mem.set('config', 'language', 'zh-CN');
      expect(mem.get<string>('config', 'language')).toBe('zh-CN');
    });

    it('returns stored object value', () => {
      const value = { token: 'ghs_xxx', expiresAt: '2026-03-20T12:00:00Z' };
      mem.set('auth', 'github', value);
      expect(mem.get('auth', 'github')).toEqual(value);
    });

    it('returns stored array value', () => {
      const value = ['item1', 'item2', 'item3'];
      mem.set('tasks', 'queue', value);
      expect(mem.get('tasks', 'queue')).toEqual(value);
    });

    it('returns stored number value', () => {
      mem.set('metrics', 'count', 42);
      expect(mem.get<number>('metrics', 'count')).toBe(42);
    });

    it('returns stored boolean value', () => {
      mem.set('flags', 'enabled', true);
      expect(mem.get<boolean>('flags', 'enabled')).toBe(true);
    });

    it('returns undefined for expired entries', () => {
      mem.set('temp', 'key', 'value', { ttl: 1 });
      // Wait for expiration
      vi.useFakeTimers();
      vi.advanceTimersByTime(10);
      expect(mem.get('temp', 'key')).toBeUndefined();
      vi.useRealTimers();
    });
  });

  describe('set', () => {
    it('stores a value in a namespace', () => {
      mem.set('auth', 'github', { token: 'test' });
      expect(mem.get('auth', 'github')).toEqual({ token: 'test' });
    });

    it('overwrites existing value', () => {
      mem.set('auth', 'github', { token: 'old' });
      mem.set('auth', 'github', { token: 'new' });
      expect(mem.get('auth', 'github')).toEqual({ token: 'new' });
    });

    it('stores values in different namespaces independently', () => {
      mem.set('auth', 'github', { token: 'ghs_xxx' });
      mem.set('auth', 'feishu', { appId: 'cli_xxx' });
      mem.set('task', 'currentTaskId', 'task-001');

      expect(mem.get('auth', 'github')).toEqual({ token: 'ghs_xxx' });
      expect(mem.get('auth', 'feishu')).toEqual({ appId: 'cli_xxx' });
      expect(mem.get('task', 'currentTaskId')).toBe('task-001');
    });

    it('deep merges when merge option is true', () => {
      mem.set('config', 'settings', { theme: 'dark', lang: 'en' });
      mem.set('config', 'settings', { lang: 'zh', fontSize: 14 }, { merge: true });
      expect(mem.get('config', 'settings')).toEqual({
        theme: 'dark',
        lang: 'zh',
        fontSize: 14,
      });
    });

    it('replaces value when merge option is false', () => {
      mem.set('config', 'settings', { theme: 'dark', lang: 'en' });
      mem.set('config', 'settings', { lang: 'zh' }, { merge: false });
      expect(mem.get('config', 'settings')).toEqual({ lang: 'zh' });
    });

    it('does not merge arrays (replaces instead)', () => {
      mem.set('data', 'items', [1, 2, 3]);
      mem.set('data', 'items', [4, 5], { merge: true });
      expect(mem.get('data', 'items')).toEqual([4, 5]);
    });

    it('does not merge primitives (replaces instead)', () => {
      mem.set('data', 'count', 10);
      mem.set('data', 'count', 20, { merge: true });
      expect(mem.get('data', 'count')).toBe(20);
    });
  });

  describe('delete', () => {
    it('deletes a key from a namespace', () => {
      mem.set('auth', 'github', { token: 'test' });
      mem.set('auth', 'feishu', { appId: 'test' });
      mem.delete('auth', 'github');
      expect(mem.get('auth', 'github')).toBeUndefined();
      expect(mem.get('auth', 'feishu')).toEqual({ appId: 'test' });
    });

    it('is a no-op for non-existent key', () => {
      expect(() => mem.delete('auth', 'nonexistent')).not.toThrow();
    });

    it('removes namespace when last key is deleted', () => {
      mem.set('auth', 'github', { token: 'test' });
      mem.delete('auth', 'github');
      expect(mem.getAll('auth')).toEqual({});
    });
  });

  describe('deleteNamespace', () => {
    it('deletes an entire namespace', () => {
      mem.set('auth', 'github', { token: 'test' });
      mem.set('auth', 'feishu', { appId: 'test' });
      mem.deleteNamespace('auth');
      expect(mem.getAll('auth')).toEqual({});
    });

    it('is a no-op for non-existent namespace', () => {
      expect(() => mem.deleteNamespace('nonexistent')).not.toThrow();
    });
  });

  // ─── getAll / getSnapshot / has ──────────────────────────────────────

  describe('getAll', () => {
    it('returns all entries in a namespace', () => {
      mem.set('auth', 'github', { token: 'ghs' });
      mem.set('auth', 'feishu', { appId: 'cli' });
      expect(mem.getAll('auth')).toEqual({
        github: { token: 'ghs' },
        feishu: { appId: 'cli' },
      });
    });

    it('returns empty object for non-existent namespace', () => {
      expect(mem.getAll('nonexistent')).toEqual({});
    });

    it('filters out expired entries', () => {
      mem.set('temp', 'a', 'value-a', { ttl: 1 });
      mem.set('temp', 'b', 'value-b');

      vi.useFakeTimers();
      vi.advanceTimersByTime(10);
      expect(mem.getAll('temp')).toEqual({ b: 'value-b' });
      vi.useRealTimers();
    });
  });

  describe('getSnapshot', () => {
    it('returns all namespaces and entries', () => {
      mem.set('auth', 'github', { token: 'ghs' });
      mem.set('task', 'id', 'task-001');
      expect(mem.getSnapshot()).toEqual({
        auth: { github: { token: 'ghs' } },
        task: { id: 'task-001' },
      });
    });

    it('returns empty object when no data', () => {
      expect(mem.getSnapshot()).toEqual({});
    });
  });

  describe('has', () => {
    it('returns true for existing key', () => {
      mem.set('auth', 'github', { token: 'test' });
      expect(mem.has('auth', 'github')).toBe(true);
    });

    it('returns false for non-existent key', () => {
      expect(mem.has('auth', 'github')).toBe(false);
    });

    it('returns false for expired key', () => {
      mem.set('temp', 'key', 'value', { ttl: 1 });
      vi.useFakeTimers();
      vi.advanceTimersByTime(10);
      expect(mem.has('temp', 'key')).toBe(false);
      vi.useRealTimers();
    });
  });

  // ─── TTL / Expiration ───────────────────────────────────────────────

  describe('TTL', () => {
    it('entry expires after TTL milliseconds', () => {
      mem.set('session', 'token', 'abc123', { ttl: 5000 });
      expect(mem.get('session', 'token')).toBe('abc123');

      vi.useFakeTimers();
      vi.advanceTimersByTime(4999);
      expect(mem.get('session', 'token')).toBe('abc123');

      vi.advanceTimersByTime(2);
      expect(mem.get('session', 'token')).toBeUndefined();
      vi.useRealTimers();
    });

    it('entries without TTL do not expire', () => {
      mem.set('config', 'key', 'value');
      vi.useFakeTimers();
      vi.advanceTimersByTime(999999999);
      expect(mem.get('config', 'key')).toBe('value');
      vi.useRealTimers();
    });

    it('TTL of 0 means no expiration', () => {
      mem.set('config', 'key', 'value', { ttl: 0 });
      vi.useFakeTimers();
      vi.advanceTimersByTime(999999999);
      expect(mem.get('config', 'key')).toBe('value');
      vi.useRealTimers();
    });
  });

  describe('cleanExpired', () => {
    it('removes all expired entries', () => {
      mem.set('temp', 'a', 'value-a', { ttl: 1 });
      mem.set('temp', 'b', 'value-b', { ttl: 1 });
      mem.set('temp', 'c', 'value-c');

      vi.useFakeTimers();
      vi.advanceTimersByTime(10);

      const cleaned = mem.cleanExpired('temp');
      expect(cleaned).toBe(2);
      expect(mem.getAll('temp')).toEqual({ c: 'value-c' });
      vi.useRealTimers();
    });

    it('cleans across all namespaces when no namespace specified', () => {
      mem.set('ns1', 'a', 'value-a', { ttl: 1 });
      mem.set('ns2', 'b', 'value-b', { ttl: 1 });
      mem.set('ns2', 'c', 'value-c');

      vi.useFakeTimers();
      vi.advanceTimersByTime(10);

      const cleaned = mem.cleanExpired();
      expect(cleaned).toBe(2);
      expect(mem.get('ns2', 'c')).toBe('value-c');
      vi.useRealTimers();
    });

    it('returns 0 when no expired entries', () => {
      mem.set('ns', 'key', 'value');
      expect(mem.cleanExpired()).toBe(0);
    });
  });

  // ─── Persistence ─────────────────────────────────────────────────────

  describe('flush', () => {
    it('writes data to disk', () => {
      mem.set('auth', 'github', { token: 'ghs_test' });
      mem.flush();

      const filePath = path.join(tmpDir, '.shared-memory.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data._meta.version).toBe(1);
      expect(data.namespaces.auth.github._value).toEqual({ token: 'ghs_test' });
    });

    it('uses atomic write (no partial reads)', () => {
      mem.set('auth', 'github', { token: 'test' });
      mem.flush();

      // Verify file is valid JSON
      const content = fs.readFileSync(path.join(tmpDir, '.shared-memory.json'), 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('does not write if not dirty', () => {
      const spy = vi.spyOn(fs, 'writeFileSync');
      mem.flush(); // Not dirty
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('updates _meta on flush', () => {
      mem.set('auth', 'key', 'value');
      mem.flush();

      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.shared-memory.json'), 'utf-8'));
      expect(data._meta.lastModified).toBeDefined();
      expect(data._meta.lastWriter).toMatch(/^pid-\d+$/);
    });
  });

  describe('reload', () => {
    it('picks up changes made by other processes', () => {
      mem.set('auth', 'github', { token: 'original' });
      mem.flush();

      // Simulate another process writing to the file
      const filePath = path.join(tmpDir, '.shared-memory.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.namespaces.auth.github._value = { token: 'updated' };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      mem.reload();
      expect(mem.get('auth', 'github')).toEqual({ token: 'updated' });
    });
  });

  // ─── Watch ───────────────────────────────────────────────────────────

  describe('watch', () => {
    it('calls callback when namespace data changes via reload', () => {
      const callback = vi.fn();
      mem.watch('auth', callback);

      // Set and flush, then modify file externally and reload
      mem.set('auth', 'github', { token: 'test' });
      mem.flush();

      const filePath = path.join(tmpDir, '.shared-memory.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.namespaces.auth.github._value = { token: 'changed' };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      mem.reload();
      expect(callback).toHaveBeenCalledWith('github', { token: 'changed' });
    });

    it('unwatch stops receiving notifications', () => {
      const callback = vi.fn();
      const unwatch = mem.watch('auth', callback);

      mem.set('auth', 'github', { token: 'test' });
      mem.flush();

      const filePath = path.join(tmpDir, '.shared-memory.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.namespaces.auth.github._value = { token: 'changed' };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      unwatch();
      mem.reload();
      expect(callback).not.toHaveBeenCalled();
    });

    it('does not notify for unchanged values', () => {
      const callback = vi.fn();
      mem.watch('auth', callback);

      mem.set('auth', 'github', { token: 'test' });
      mem.flush();

      // Reload same data
      mem.reload();
      expect(callback).not.toHaveBeenCalled();
    });

    it('handles callback errors gracefully', () => {
      const badCallback = vi.fn(() => {
        throw new Error('callback error');
      });
      mem.watch('auth', badCallback);

      mem.set('auth', 'github', { token: 'test' });
      mem.flush();

      const filePath = path.join(tmpDir, '.shared-memory.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.namespaces.auth.github._value = { token: 'changed' };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      // Should not throw
      expect(() => mem.reload()).not.toThrow();
    });
  });

  // ─── Backward Compatibility ──────────────────────────────────────────

  describe('migrateFromRuntimeEnv', () => {
    it('migrates entries from .runtime-env file', () => {
      const runtimeEnvPath = path.join(tmpDir, '.runtime-env');
      fs.writeFileSync(runtimeEnvPath, '# comment\nGH_TOKEN=ghs_test\nAWS_KEY=AKIA_test\n');

      const count = mem.migrateFromRuntimeEnv(tmpDir);
      expect(count).toBe(2);
      expect(mem.get('runtime-env', 'GH_TOKEN')).toBe('ghs_test');
      expect(mem.get('runtime-env', 'AWS_KEY')).toBe('AKIA_test');
    });

    it('does not overwrite existing entries', () => {
      const runtimeEnvPath = path.join(tmpDir, '.runtime-env');
      fs.writeFileSync(runtimeEnvPath, 'GH_TOKEN=ghs_old\n');

      mem.set('runtime-env', 'GH_TOKEN', 'ghs_new');
      const count = mem.migrateFromRuntimeEnv(tmpDir);
      expect(count).toBe(0);
      expect(mem.get('runtime-env', 'GH_TOKEN')).toBe('ghs_new');
    });

    it('returns 0 when .runtime-env does not exist', () => {
      const count = mem.migrateFromRuntimeEnv(tmpDir);
      expect(count).toBe(0);
    });
  });

  describe('exportAsEnvVars', () => {
    it('exports namespace as flat string Record', () => {
      mem.set('runtime-env', 'GH_TOKEN', 'ghs_test');
      mem.set('runtime-env', 'AWS_KEY', 'AKIA_test');

      const envVars = mem.exportAsEnvVars();
      expect(envVars).toEqual({
        GH_TOKEN: 'ghs_test',
        AWS_KEY: 'AKIA_test',
      });
    });

    it('converts non-string values to strings', () => {
      mem.set('runtime-env', 'PORT', 8080);
      mem.set('runtime-env', 'DEBUG', true);

      const envVars = mem.exportAsEnvVars();
      expect(envVars.PORT).toBe('8080');
      expect(envVars.DEBUG).toBe('true');
    });

    it('returns empty object for empty namespace', () => {
      expect(mem.exportAsEnvVars()).toEqual({});
    });
  });

  // ─── dispose ─────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('flushes pending changes', () => {
      mem.set('auth', 'key', 'value');
      mem.dispose();

      const filePath = path.join(tmpDir, '.shared-memory.json');
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });
});

// ─── Factory Function ───────────────────────────────────────────────────────

describe('createSharedMemory', () => {
  it('creates a SharedMemory instance', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-memory-factory-'));
    const mem = createSharedMemory(tmpDir);
    expect(mem).toBeInstanceOf(SharedMemory);
    mem.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
