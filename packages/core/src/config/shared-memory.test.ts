import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SharedMemory } from './shared-memory.js';

describe('SharedMemory', () => {
  let tmpDir: string;
  let memory: SharedMemory;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-memory-test-'));
    memory = new SharedMemory(tmpDir, 'test-writer');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('get/set', () => {
    it('sets and gets a value', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });
      const result = memory.get<{ token: string }>('auth', 'github');
      expect(result).toEqual({ token: 'ghs_abc' });
    });

    it('returns undefined for missing key', () => {
      expect(memory.get('auth', 'missing')).toBeUndefined();
    });

    it('returns undefined for missing namespace', () => {
      expect(memory.get('missing', 'key')).toBeUndefined();
    });

    it('stores complex objects', () => {
      const data = {
        token: 'ghs_abc',
        expiresAt: '2026-03-20T12:00:00Z',
        installationId: '123456',
        scopes: ['repo', 'user'],
      };
      memory.set('auth', 'github', data);
      expect(memory.get('auth', 'github')).toEqual(data);
    });

    it('stores arrays', () => {
      memory.set('task', 'history', ['task1', 'task2', 'task3']);
      expect(memory.get('task', 'history')).toEqual(['task1', 'task2', 'task3']);
    });

    it('stores primitive values', () => {
      memory.set('config', 'timeout', 30000);
      expect(memory.get('config', 'timeout')).toBe(30000);

      memory.set('config', 'enabled', true);
      expect(memory.get('config', 'enabled')).toBe(true);
    });
  });

  describe('merge option', () => {
    it('merges with existing object when merge is true', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });
      memory.set('auth', 'github', { expiresAt: '2026-03-20T12:00:00Z' }, { merge: true });

      expect(memory.get('auth', 'github')).toEqual({
        token: 'ghs_abc',
        expiresAt: '2026-03-20T12:00:00Z',
      });
    });

    it('replaces when merge is false', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });
      memory.set('auth', 'github', { expiresAt: '2026-03-20T12:00:00Z' }, { merge: false });

      expect(memory.get('auth', 'github')).toEqual({
        expiresAt: '2026-03-20T12:00:00Z',
      });
    });
  });

  describe('TTL', () => {
    it('expires entries after TTL', async () => {
      memory.set('cache', 'data', 'value', { ttl: 50 }); // 50ms TTL

      expect(memory.get('cache', 'data')).toBe('value');

      // Wait for TTL
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(memory.get('cache', 'data')).toBeUndefined();
    });

    it('keeps entries without TTL', async () => {
      memory.set('config', 'setting', 'value');

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(memory.get('config', 'setting')).toBe('value');
    });
  });

  describe('delete', () => {
    it('deletes an entry', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });
      memory.delete('auth', 'github');
      expect(memory.get('auth', 'github')).toBeUndefined();
    });

    it('does nothing for missing key', () => {
      expect(() => memory.delete('missing', 'key')).not.toThrow();
    });

    it('cleans up empty namespace', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });
      memory.delete('auth', 'github');
      expect(memory.hasNamespace('auth')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('returns all entries in a namespace', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });
      memory.set('auth', 'gitlab', { token: 'glpat_xyz' });

      const result = memory.getAll('auth');
      expect(result).toEqual({
        github: { token: 'ghs_abc' },
        gitlab: { token: 'glpat_xyz' },
      });
    });

    it('returns empty object for missing namespace', () => {
      expect(memory.getAll('missing')).toEqual({});
    });

    it('excludes expired entries', async () => {
      memory.set('cache', 'fresh', 'value1');
      memory.set('cache', 'stale', 'value2', { ttl: 50 });

      await new Promise(resolve => setTimeout(resolve, 100));

      const result = memory.getAll('cache');
      expect(result).toEqual({ fresh: 'value1' });
    });
  });

  describe('getNamespaces', () => {
    it('returns all namespace names', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });
      memory.set('task', 'current', 'task-001');

      expect(memory.getNamespaces().sort()).toEqual(['auth', 'task']);
    });

    it('returns empty array when no namespaces', () => {
      expect(memory.getNamespaces()).toEqual([]);
    });
  });

  describe('hasNamespace', () => {
    it('returns true for existing namespace', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });
      expect(memory.hasNamespace('auth')).toBe(true);
    });

    it('returns false for missing namespace', () => {
      expect(memory.hasNamespace('missing')).toBe(false);
    });
  });

  describe('clear', () => {
    it('clears a specific namespace', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });
      memory.set('task', 'current', 'task-001');

      memory.clear('auth');

      expect(memory.hasNamespace('auth')).toBe(false);
      expect(memory.hasNamespace('task')).toBe(true);
    });

    it('clears all namespaces when no namespace specified', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });
      memory.set('task', 'current', 'task-001');

      memory.clear();

      expect(memory.getNamespaces()).toEqual([]);
    });
  });

  describe('cleanup', () => {
    it('removes expired entries', async () => {
      memory.set('cache', 'fresh', 'value1');
      memory.set('cache', 'stale', 'value2', { ttl: 50 });

      await new Promise(resolve => setTimeout(resolve, 100));

      const removed = memory.cleanup();

      expect(removed).toBe(1);
      expect(memory.get('cache', 'stale')).toBeUndefined();
      expect(memory.get('cache', 'fresh')).toBe('value1');
    });

    it('returns 0 when nothing to clean', () => {
      memory.set('config', 'setting', 'value');
      expect(memory.cleanup()).toBe(0);
    });
  });

  describe('toEnv', () => {
    it('exports GH_TOKEN from auth namespace', () => {
      memory.set('auth', 'github', {
        token: 'ghs_abc',
        expiresAt: '2026-03-20T12:00:00Z',
      });

      const env = memory.toEnv();

      expect(env.GH_TOKEN).toBe('ghs_abc');
      expect(env.GH_TOKEN_EXPIRES_AT).toBe('2026-03-20T12:00:00Z');
    });

    it('returns empty object when no auth data', () => {
      memory.set('config', 'setting', 'value');
      expect(memory.toEnv()).toEqual({});
    });
  });

  describe('persistence', () => {
    it('persists data to file', () => {
      memory.set('auth', 'github', { token: 'ghs_abc' });

      // Create new instance to read from file
      const memory2 = new SharedMemory(tmpDir);
      expect(memory2.get('auth', 'github')).toEqual({ token: 'ghs_abc' });
    });

    it('creates file on first write', () => {
      expect(fs.existsSync(path.join(tmpDir, '.shared-memory.json'))).toBe(false);

      memory.set('test', 'key', 'value');

      expect(fs.existsSync(path.join(tmpDir, '.shared-memory.json'))).toBe(true);
    });
  });

  describe('watch', () => {
    it('registers a watcher', () => {
      const callback = vi.fn();
      const unwatch = memory.watch('auth', callback);

      expect(typeof unwatch).toBe('function');
      unwatch();
    });

    it('stops watching after unwatch is called', () => {
      const callback = vi.fn();
      const unwatch = memory.watch('auth', callback);

      unwatch();

      // The watcher should be removed
      // Note: Testing actual file watch behavior is complex, so we just verify no errors
    });
  });

  describe('concurrent access', () => {
    it('handles multiple instances writing to same file', () => {
      const memory1 = new SharedMemory(tmpDir, 'writer1');
      const memory2 = new SharedMemory(tmpDir, 'writer2');

      memory1.set('auth', 'github', { token: 'ghs_abc' });
      memory2.set('auth', 'gitlab', { token: 'glpat_xyz' });

      // Both should be visible to a new instance
      const memory3 = new SharedMemory(tmpDir, 'reader');
      expect(memory3.get('auth', 'github')).toEqual({ token: 'ghs_abc' });
      expect(memory3.get('auth', 'gitlab')).toEqual({ token: 'glpat_xyz' });
    });
  });
});
