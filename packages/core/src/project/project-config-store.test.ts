/**
 * Tests for ProjectConfigStore (Issue #3329 Phase 2 / Issue #3581).
 *
 * @see Issue #3581 — Unit Tests scope:
 * - CRUD: register, unregister, get, list
 * - ProjectChatIdResolver: resolve projectKey → chatId
 * - CwdProvider: resolve chatId → workingDir
 * - Lookup helpers: getByChatId, size
 */

import { describe, it, expect } from 'vitest';
import { ProjectConfigStore } from './project-config-store.js';
import type { ProjectConfig } from './types.js';

// ============================================================================
// Helpers
// ============================================================================

function createConfig(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    key: 'hs3180/disclaude',
    workingDir: '/workspace/disclaude',
    chatId: 'oc_test_chat',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ProjectConfigStore', () => {
  describe('register + get', () => {
    it('should register and retrieve a config', () => {
      const store = new ProjectConfigStore();
      const config = createConfig();

      store.register(config);

      expect(store.get('hs3180/disclaude')).toEqual(config);
    });

    it('should return undefined for unknown key', () => {
      const store = new ProjectConfigStore();

      expect(store.get('unknown')).toBeUndefined();
    });

    it('should replace existing config on re-register', () => {
      const store = new ProjectConfigStore();
      store.register(createConfig());
      const updated = createConfig({ chatId: 'oc_new_chat' });

      store.register(updated);

      expect(store.get('hs3180/disclaude')).toEqual(updated);
      expect(store.size()).toBe(1);
    });

    it('should register multiple configs', () => {
      const store = new ProjectConfigStore();
      store.register(createConfig({ key: 'project-a', chatId: 'oc_a' }));
      store.register(createConfig({ key: 'project-b', chatId: 'oc_b' }));

      expect(store.size()).toBe(2);
      expect(store.get('project-a')?.chatId).toBe('oc_a');
      expect(store.get('project-b')?.chatId).toBe('oc_b');
    });
  });

  describe('unregister', () => {
    it('should remove a config by key', () => {
      const store = new ProjectConfigStore();
      store.register(createConfig());

      const result = store.unregister('hs3180/disclaude');

      expect(result).toBe(true);
      expect(store.get('hs3180/disclaude')).toBeUndefined();
    });

    it('should return false for unknown key', () => {
      const store = new ProjectConfigStore();

      expect(store.unregister('unknown')).toBe(false);
    });
  });

  describe('has', () => {
    it('should return true for registered key', () => {
      const store = new ProjectConfigStore();
      store.register(createConfig());

      expect(store.has('hs3180/disclaude')).toBe(true);
    });

    it('should return false for unknown key', () => {
      const store = new ProjectConfigStore();

      expect(store.has('unknown')).toBe(false);
    });
  });

  describe('list', () => {
    it('should return empty array for empty store', () => {
      const store = new ProjectConfigStore();

      expect(store.list()).toEqual([]);
    });

    it('should list all registered configs', () => {
      const store = new ProjectConfigStore();
      const configA = createConfig({ key: 'project-a' });
      const configB = createConfig({ key: 'project-b' });
      store.register(configA);
      store.register(configB);

      const list = store.list();

      expect(list).toHaveLength(2);
      expect(list).toContainEqual(configA);
      expect(list).toContainEqual(configB);
    });
  });

  describe('resolve (ProjectChatIdResolver)', () => {
    it('should resolve projectKey to chatId', () => {
      const store = new ProjectConfigStore();
      store.register(createConfig());

      expect(store.resolve('hs3180/disclaude')).toBe('oc_test_chat');
    });

    it('should return undefined for unknown projectKey', () => {
      const store = new ProjectConfigStore();

      expect(store.resolve('unknown/project')).toBeUndefined();
    });

    it('should resolve different projects to different chatIds', () => {
      const store = new ProjectConfigStore();
      store.register(createConfig({ key: 'project-a', chatId: 'oc_chat_a' }));
      store.register(createConfig({ key: 'project-b', chatId: 'oc_chat_b' }));

      expect(store.resolve('project-a')).toBe('oc_chat_a');
      expect(store.resolve('project-b')).toBe('oc_chat_b');
    });
  });

  describe('createCwdProvider', () => {
    it('should return undefined for unregistered chatId', () => {
      const store = new ProjectConfigStore();
      const cwdProvider = store.createCwdProvider();

      expect(cwdProvider('oc_unknown')).toBeUndefined();
    });

    it('should return workingDir for registered chatId', () => {
      const store = new ProjectConfigStore();
      store.register(createConfig());
      const cwdProvider = store.createCwdProvider();

      expect(cwdProvider('oc_test_chat')).toBe('/workspace/disclaude');
    });

    it('should reflect runtime changes to registered configs', () => {
      const store = new ProjectConfigStore();
      const cwdProvider = store.createCwdProvider();

      // Initially no mapping
      expect(cwdProvider('oc_test_chat')).toBeUndefined();

      // Register a config
      store.register(createConfig());
      expect(cwdProvider('oc_test_chat')).toBe('/workspace/disclaude');

      // Unregister
      store.unregister('hs3180/disclaude');
      expect(cwdProvider('oc_test_chat')).toBeUndefined();
    });

    it('should resolve multiple chatIds to their respective workingDirs', () => {
      const store = new ProjectConfigStore();
      store.register(createConfig({ key: 'project-a', chatId: 'oc_a', workingDir: '/ws/a' }));
      store.register(createConfig({ key: 'project-b', chatId: 'oc_b', workingDir: '/ws/b' }));
      const cwdProvider = store.createCwdProvider();

      expect(cwdProvider('oc_a')).toBe('/ws/a');
      expect(cwdProvider('oc_b')).toBe('/ws/b');
    });
  });

  describe('getByChatId', () => {
    it('should find config by chatId', () => {
      const store = new ProjectConfigStore();
      store.register(createConfig());

      expect(store.getByChatId('oc_test_chat')?.key).toBe('hs3180/disclaude');
    });

    it('should return undefined for unknown chatId', () => {
      const store = new ProjectConfigStore();

      expect(store.getByChatId('oc_unknown')).toBeUndefined();
    });
  });

  describe('size', () => {
    it('should return 0 for empty store', () => {
      const store = new ProjectConfigStore();

      expect(store.size()).toBe(0);
    });

    it('should reflect registered configs', () => {
      const store = new ProjectConfigStore();
      store.register(createConfig({ key: 'a' }));
      store.register(createConfig({ key: 'b' }));

      expect(store.size()).toBe(2);
    });
  });
});
