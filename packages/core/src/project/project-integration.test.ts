/**
 * Integration tests for Project module exports (Issue #2227 Sub-Issue E).
 *
 * Verifies:
 * - ProjectManager is re-exported from @disclaude/core
 * - All types are correctly exported
 * - createCwdProvider works with use()/reset() updates
 *
 * @see Issue #2227
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import {
  ProjectManager,
  discoverTemplates,
  discoveryResultToConfig,
  discoverTemplatesAsConfig,
  type CwdProvider,
  type InstanceInfo,
  type ProjectContextConfig,
  type ProjectManagerOptions,
  type ProjectResult,
  type ProjectTemplate,
  type ProjectTemplatesConfig,
  type PersistedInstance,
  type ProjectsPersistData,
  type DiscoveryResult,
  type DiscoveryError,
  type DiscoveryOptions,
} from '../index.js';

describe('Project module integration (Issue #2227)', () => {
  // ───────────────────────────────────────────
  // Re-export verification
  // ───────────────────────────────────────────

  describe('module exports', () => {
    it('should export ProjectManager class', () => {
      expect(ProjectManager).toBeDefined();
      expect(typeof ProjectManager).toBe('function');
    });

    it('should export discoverTemplates function', () => {
      expect(discoverTemplates).toBeDefined();
      expect(typeof discoverTemplates).toBe('function');
    });

    it('should export discoveryResultToConfig function', () => {
      expect(discoveryResultToConfig).toBeDefined();
      expect(typeof discoveryResultToConfig).toBe('function');
    });

    it('should export discoverTemplatesAsConfig function', () => {
      expect(discoverTemplatesAsConfig).toBeDefined();
      expect(typeof discoverTemplatesAsConfig).toBe('function');
    });

    it('should support type-only imports', () => {
      // Type-only imports compile successfully — this test verifies
      // the types are correctly re-exported at compile time.

      const cwdProvider: CwdProvider = (_chatId: string) => undefined;
      expect(cwdProvider).toBeDefined();

      const template: ProjectTemplate = { name: 'test' };
      expect(template.name).toBe('test');

      const templatesConfig: ProjectTemplatesConfig = {
        research: { displayName: '研究模式' },
      };
      expect(templatesConfig.research?.displayName).toBe('研究模式');

      type _TCheck = ProjectResult<string>;
      type _ICheck = InstanceInfo;
      type _PCCheck = ProjectContextConfig;
      type _PMOCheck = ProjectManagerOptions;
      type _PICheck = PersistedInstance;
      type _PPDCheck = ProjectsPersistData;
      type _DRCheck = DiscoveryResult;
      type _DECheck = DiscoveryError;
      type _DOCheck = DiscoveryOptions;

      expect(true).toBe(true);
    });
  });

  // ───────────────────────────────────────────
  // createCwdProvider with use()/reset() updates
  // ───────────────────────────────────────────

  describe('createCwdProvider dynamic updates', () => {
    let tmpDir: string;
    let pm: ProjectManager;

    beforeEach(() => {
      tmpDir = `/tmp/disclaude-test-pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      mkdirSync(tmpDir, { recursive: true });
      pm = new ProjectManager({
        workspaceDir: tmpDir,
        packageDir: tmpDir,
        templatesConfig: {
          research: { displayName: '研究模式', description: '研究空间' },
        },
      });
    });

    afterEach(() => {
      // Clean up temp directory
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should return undefined for default project', () => {
      const cwdProvider = pm.createCwdProvider();
      const result = cwdProvider('chat-1');
      expect(result).toBeUndefined();
    });

    it('should return workingDir after use()', () => {
      // Create instance first
      const createResult = pm.create('chat-1', 'research', 'my-research');
      expect(createResult.ok).toBe(true);

      // Now use it
      const useResult = pm.use('chat-2', 'my-research');
      expect(useResult.ok).toBe(true);

      const cwdProvider = pm.createCwdProvider();
      const result = cwdProvider('chat-2');
      expect(result).toBe(`${tmpDir}/projects/my-research`);
    });

    it('should return undefined after reset()', () => {
      // Create and use
      pm.create('chat-1', 'research', 'my-research');
      pm.use('chat-1', 'my-research');

      const cwdProvider = pm.createCwdProvider();

      // Verify bound
      expect(cwdProvider('chat-1')).toBe(`${tmpDir}/projects/my-research`);

      // Reset
      pm.reset('chat-1');

      // Should return undefined (default)
      expect(cwdProvider('chat-1')).toBeUndefined();
    });

    it('should reflect dynamic changes across use() calls', () => {
      pm.create('chat-1', 'research', 'proj-a');
      pm.create('chat-1b', 'research', 'proj-b');

      const cwdProvider = pm.createCwdProvider();

      // chat-1 uses proj-a
      pm.use('chat-1', 'proj-a');
      expect(cwdProvider('chat-1')).toBe(`${tmpDir}/projects/proj-a`);

      // Rebind chat-1 to proj-b
      pm.use('chat-1', 'proj-b');
      expect(cwdProvider('chat-1')).toBe(`${tmpDir}/projects/proj-b`);

      // chat-2 not bound yet (no create/use for chat-2)
      expect(cwdProvider('chat-2')).toBeUndefined();

      // Bind chat-2 to proj-a
      pm.use('chat-2', 'proj-a');
      expect(cwdProvider('chat-2')).toBe(`${tmpDir}/projects/proj-a`);
    });

    it('should handle multiple cwdProviders from same manager', () => {
      pm.create('chat-1', 'research', 'shared-proj');

      const provider1 = pm.createCwdProvider();
      const provider2 = pm.createCwdProvider();

      pm.use('chat-1', 'shared-proj');

      // Both providers should reflect the same state
      expect(provider1('chat-1')).toBe(`${tmpDir}/projects/shared-proj`);
      expect(provider2('chat-1')).toBe(`${tmpDir}/projects/shared-proj`);
    });
  });

  // ───────────────────────────────────────────
  // Template discovery integration
  // ───────────────────────────────────────────

  describe('template discovery integration', () => {
    it('should return empty result for non-existent directory', () => {
      const result = discoverTemplates('/non/existent/path');
      expect(result.templates).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('should convert discovery result to config format', () => {
      const result = discoverTemplates('/non/existent/path');
      const config = discoveryResultToConfig(result);
      expect(config).toEqual({});
    });

    it('should combine discoverTemplatesAsConfig', () => {
      const config = discoverTemplatesAsConfig('/non/existent/path');
      expect(config).toEqual({});
    });
  });
});
