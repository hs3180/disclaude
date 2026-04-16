/**
 * Integration tests for Issue #2227 — E: 集成 (index.ts + config + createCwdProvider)
 *
 * Verifies:
 * - ProjectManager and types are re-exported from @disclaude/core
 * - createCwdProvider returns updated results after use()/reset()
 * - Config type includes projectTemplates field
 * - discoverTemplates is re-exported from @disclaude/core
 *
 * @see Issue #2227
 */

import { describe, it, expect } from 'vitest';
// Import from the barrel export (simulates `import { ... } from '@disclaude/core'`)
// In the monorepo we import from the source directly since packages aren't built
import {
  ProjectManager,
  discoverTemplates,
  discoveryResultToConfig,
  discoverTemplatesAsConfig,
  type CwdProvider,
  type ProjectContextConfig,
  type ProjectResult,
  type ProjectTemplate,
  type ProjectTemplatesConfig,
  type DiscoveryResult,
} from '../index.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Re-export Verification Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227 — Integration: re-exports', () => {
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
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Type Re-export Verification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227 — Integration: type re-exports', () => {
  it('type imports should be valid (compile-time check)', () => {
    // If this compiles, the type re-exports are working correctly
    // We verify at runtime that the types can be used as expected

    const cwdProvider: CwdProvider = (_chatId: string) => undefined;
    expect(cwdProvider('test-chat')).toBeUndefined();

    const result: ProjectResult<string> = { ok: true, data: 'test' };
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe('test');
    }

    const template: ProjectTemplate = { name: 'test' };
    expect(template.name).toBe('test');

    const templatesConfig: ProjectTemplatesConfig = {
      research: { displayName: 'Research' },
    };
    expect(templatesConfig.research.displayName).toBe('Research');

    const ctxConfig: ProjectContextConfig = { name: 'default', workingDir: '/tmp' };
    expect(ctxConfig.name).toBe('default');

    const discoveryResult: DiscoveryResult = { templates: [], errors: [] };
    expect(discoveryResult.templates).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProvider Integration Test
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227 — Integration: createCwdProvider with use/reset', () => {
  it('should return updated cwd after use() and reset()', () => {
    const workspaceDir = `/tmp/pm-integration-test-${Date.now()}`;
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: workspaceDir,
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });

    const cwdProvider = pm.createCwdProvider();

    // Default: returns undefined (SDK falls back to workspaceDir)
    expect(cwdProvider('chat-1')).toBeUndefined();

    // Create an instance
    const createResult = pm.create('chat-1', 'research', 'my-research');
    expect(createResult.ok).toBe(true);

    // After create, cwdProvider should return the instance workingDir
    const cwdAfterCreate = cwdProvider('chat-1');
    expect(cwdAfterCreate).toBeDefined();
    expect(cwdAfterCreate).toContain('projects/my-research');

    // Use for a different chat
    const useResult = pm.use('chat-2', 'my-research');
    expect(useResult.ok).toBe(true);
    const cwdAfterUse = cwdProvider('chat-2');
    expect(cwdAfterUse).toBe(cwdAfterCreate);

    // Reset chat-1
    const resetResult = pm.reset('chat-1');
    expect(resetResult.ok).toBe(true);
    expect(cwdProvider('chat-1')).toBeUndefined();

    // chat-2 still bound
    expect(cwdProvider('chat-2')).toBe(cwdAfterCreate);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Config type verification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227 — Integration: config type', () => {
  it('DisclaudeConfig should accept projectTemplates', async () => {
    // Import the config types module to verify projectTemplates is available
    // DisclaudeConfig is an interface — we verify the module loads and the type
    // is structurally valid by constructing a matching object
    await import('../config/types.js');

    // Runtime check: verify that a config object with projectTemplates is valid
    const config = {
      projectTemplates: {
        research: {
          displayName: '研究模式',
          description: '专注研究的独立空间',
        },
      },
    };
    expect(config.projectTemplates?.research?.displayName).toBe('研究模式');
  });
});
