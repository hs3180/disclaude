/**
 * Integration tests for ProjectManager config wiring and createCwdProvider.
 *
 * Tests the integration layer (Sub-Issue E, #2227) that bridges
 * ProjectManager with the config system.
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import { describe, it, expect } from 'vitest';
import {
  createCwdProviderFromConfig,
} from './integration.js';
import { noOpFs } from './project-manager.js';
import type { ProjectTemplatesConfig } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function defaultOptions(overrides?: {
  templatesConfig?: ProjectTemplatesConfig;
}) {
  return {
    workspaceDir: '/workspace',
    packageDir: '/app/packages/core',
    templatesConfig: overrides?.templatesConfig,
    fsOps: noOpFs, // Use noOpFs for unit tests (no real filesystem)
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProviderFromConfig
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('createCwdProviderFromConfig', () => {
  it('should return a CwdProvider and ProjectManager', () => {
    const { provider, manager } = createCwdProviderFromConfig(defaultOptions());

    expect(provider).toBeTypeOf('function');
    expect(manager).toBeDefined();
  });

  it('should return undefined for default project (no bindings)', () => {
    const { provider } = createCwdProviderFromConfig(defaultOptions());

    // No project bound → default → undefined
    const result = provider('chat-123');
    expect(result).toBeUndefined();
  });

  it('should initialize with templates from config', () => {
    const templates: ProjectTemplatesConfig = {
      research: { displayName: '研究模式', description: '专注研究' },
      'book-reader': { displayName: '读书助手' },
    };

    const { manager } = createCwdProviderFromConfig(
      defaultOptions({ templatesConfig: templates }),
    );

    const templateList = manager.listTemplates();
    expect(templateList).toHaveLength(2);
    expect(templateList.map((t) => t.name).sort()).toEqual([
      'book-reader',
      'research',
    ]);
  });

  it('should work with empty templates config', () => {
    const { provider, manager } = createCwdProviderFromConfig(
      defaultOptions({ templatesConfig: {} }),
    );

    expect(provider('any-chat')).toBeUndefined();
    expect(manager.listTemplates()).toHaveLength(0);
  });

  it('should work without templates config (undefined)', () => {
    const { provider, manager } = createCwdProviderFromConfig(defaultOptions());

    expect(provider('any-chat')).toBeUndefined();
    expect(manager.listTemplates()).toHaveLength(0);
  });

  it('provider should reflect project bindings after use()', () => {
    const templates: ProjectTemplatesConfig = {
      research: { displayName: '研究模式' },
    };

    const { provider, manager } = createCwdProviderFromConfig(
      defaultOptions({ templatesConfig: templates }),
    );

    // Before binding: default → undefined
    expect(provider('chat-abc')).toBeUndefined();

    // Create and bind a project instance
    const createResult = manager.create('chat-abc', 'research', 'my-research');
    expect(createResult.ok).toBe(true);

    // After binding: provider returns the project's working dir
    // Note: noOpFs is used, so filesystem ops are no-ops
    const cwd = provider('chat-abc');
    expect(cwd).toBe('/workspace/projects/my-research');
  });

  it('provider should return undefined after reset()', () => {
    const templates: ProjectTemplatesConfig = {
      research: { displayName: '研究模式' },
    };

    const { provider, manager } = createCwdProviderFromConfig(
      defaultOptions({ templatesConfig: templates }),
    );

    manager.create('chat-xyz', 'research', 'temp-project');

    // Bound → returns working dir
    expect(provider('chat-xyz')).toBe('/workspace/projects/temp-project');

    // Reset → back to default
    manager.reset('chat-xyz');

    // After reset: default → undefined
    expect(provider('chat-xyz')).toBeUndefined();
  });

  it('different chatIds should have independent bindings', () => {
    const templates: ProjectTemplatesConfig = {
      research: { displayName: '研究模式' },
      coding: { displayName: '编程助手' },
    };

    const { provider, manager } = createCwdProviderFromConfig(
      defaultOptions({ templatesConfig: templates }),
    );

    manager.create('chat-A', 'research', 'project-a');
    manager.create('chat-B', 'coding', 'project-b');

    expect(provider('chat-A')).toBe('/workspace/projects/project-a');
    expect(provider('chat-B')).toBe('/workspace/projects/project-b');

    // Reset only chat-A
    manager.reset('chat-A');
    expect(provider('chat-A')).toBeUndefined();
    expect(provider('chat-B')).toBe('/workspace/projects/project-b');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Re-export verification (acceptance criteria)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Acceptance: module exports', () => {
  it('should re-export ProjectManager from project/index', async () => {
    const mod = await import('./index.js');
    expect(mod.ProjectManager).toBeDefined();
    expect(typeof mod.ProjectManager).toBe('function');
  });

  it('should re-export createCwdProviderFromConfig from project/index', async () => {
    const mod = await import('./index.js');
    expect(mod.createCwdProviderFromConfig).toBeDefined();
    expect(typeof mod.createCwdProviderFromConfig).toBe('function');
  });

  it('should export all required types from project/index', async () => {
    // Type-only exports are verified at compile time.
    // This test ensures the module loads without errors.
    const mod = await import('./index.js');
    // Runtime value exports
    expect(mod.ProjectManager).toBeDefined();
    expect(mod.noOpFs).toBeDefined();
    expect(mod.createCwdProviderFromConfig).toBeDefined();
  });
});
