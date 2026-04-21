/**
 * Tests for ProjectManager integration into @disclaude/core exports.
 *
 * Verifies Issue #2227 acceptance criteria:
 * - `import { ProjectManager } from '@disclaude/core'` works
 * - All types are correctly exported
 * - createCwdProvider is available through the module
 *
 * @see Issue #2227
 */

import { describe, it, expect } from 'vitest';

// Import from the core barrel (simulates `import { ... } from '@disclaude/core'`)
import {
  ProjectManager,
  discoverTemplates,
  discoveryResultToConfig,
  discoverTemplatesAsConfig,
  type CwdProvider,
  type ProjectResult,
  type ProjectTemplatesConfigFromModule,
} from '../index.js';

describe('Project module exports via @disclaude/core', () => {
  describe('ProjectManager class', () => {
    it('should be importable from @disclaude/core', () => {
      expect(ProjectManager).toBeDefined();
      expect(typeof ProjectManager).toBe('function');
    });

    it('should have createCwdProvider method', () => {
      const pm = new ProjectManager({
        workspaceDir: '/tmp/test-workspace',
        packageDir: '/tmp/test-package',
        templatesConfig: {},
      });
      expect(typeof pm.createCwdProvider).toBe('function');
    });
  });

  describe('Template discovery functions', () => {
    it('should export discoverTemplates', () => {
      expect(typeof discoverTemplates).toBe('function');
    });

    it('should export discoveryResultToConfig', () => {
      expect(typeof discoveryResultToConfig).toBe('function');
    });

    it('should export discoverTemplatesAsConfig', () => {
      expect(typeof discoverTemplatesAsConfig).toBe('function');
    });
  });

  describe('Type exports', () => {
    it('should allow using CwdProvider type', () => {
      const provider: CwdProvider = (_chatId: string) => undefined;
      expect(provider('test')).toBeUndefined();
    });

    it('should allow using ProjectResult type', () => {
      const success: ProjectResult<string> = { ok: true, data: 'test' };
      const failure: ProjectResult<string> = { ok: false, error: 'error' };
      expect(success.ok).toBe(true);
      expect(failure.ok).toBe(false);
    });

    it('should allow using ProjectTemplatesConfigFromModule type', () => {
      const config: ProjectTemplatesConfigFromModule = {
        research: { displayName: '研究模式' },
      };
      expect(config.research.displayName).toBe('研究模式');
    });
  });
});
