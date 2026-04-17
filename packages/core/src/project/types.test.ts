/**
 * Type-level tests for ProjectManager types.
 *
 * Since types.ts is pure type definitions (no runtime logic),
 * these tests verify structural correctness through runtime type guards
 * and discriminated union behavior.
 *
 * @see Issue #2223
 */

import { describe, it, expect } from 'vitest';
import type {
  CwdProvider,
  InstanceInfo,
  PersistedInstance,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
  ProjectTemplate,
  ProjectTemplatesConfig,
  ProjectsPersistData,
} from './types.js';

describe('ProjectResult<T> discriminated union', () => {
  it('should accept success result', () => {
    const result: ProjectResult<ProjectContextConfig> = {
      ok: true,
      data: {
        name: 'my-research',
        templateName: 'research',
        workingDir: '/workspace/projects/my-research',
      },
    };
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('my-research');
      expect(result.data.workingDir).toBe('/workspace/projects/my-research');
    }
  });

  it('should accept failure result', () => {
    const result: ProjectResult<ProjectContextConfig> = {
      ok: false,
      error: '模板不存在',
    };
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('模板不存在');
    }
  });

  it('should narrow types correctly via discriminated union', () => {
    function handleResult(result: ProjectResult<string>) {
      if (result.ok) {
        return `Success: ${result.data.toUpperCase()}`;
      }
      return `Error: ${result.error}`;
    }

    expect(handleResult({ ok: true, data: 'hello' })).toBe('Success: HELLO');
    expect(handleResult({ ok: false, error: 'fail' })).toBe('Error: fail');
  });

  it('should work with void data type', () => {
    const result: ProjectResult<void> = { ok: true, data: undefined };
    expect(result.ok).toBe(true);
  });

  it('should work with array data type', () => {
    const result: ProjectResult<ProjectTemplate[]> = {
      ok: true,
      data: [
        { name: 'research', displayName: '研究模式' },
        { name: 'book-reader' },
      ],
    };
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0].name).toBe('research');
    }
  });
});

describe('ProjectContextConfig', () => {
  it('should accept minimal config (default project)', () => {
    const config: ProjectContextConfig = {
      name: 'default',
      workingDir: '/workspace',
    };
    expect(config.name).toBe('default');
    expect(config.templateName).toBeUndefined();
  });

  it('should accept full config', () => {
    const config: ProjectContextConfig = {
      name: 'my-research',
      templateName: 'research',
      workingDir: '/workspace/projects/my-research',
    };
    expect(config.name).toBe('my-research');
    expect(config.templateName).toBe('research');
  });
});

describe('InstanceInfo', () => {
  it('should accept valid instance info', () => {
    const info: InstanceInfo = {
      name: 'my-research',
      templateName: 'research',
      chatIds: ['oc_abc123', 'oc_def456'],
      workingDir: '/workspace/projects/my-research',
      createdAt: '2026-04-09T10:00:00Z',
    };
    expect(info.name).toBe('my-research');
    expect(info.chatIds).toHaveLength(2);
  });

  it('should accept instance with no bindings', () => {
    const info: InstanceInfo = {
      name: 'orphan-project',
      templateName: 'research',
      chatIds: [],
      workingDir: '/workspace/projects/orphan-project',
      createdAt: '2026-04-09T10:00:00Z',
    };
    expect(info.chatIds).toHaveLength(0);
  });
});

describe('ProjectTemplate', () => {
  it('should accept template with all fields', () => {
    const template: ProjectTemplate = {
      name: 'research',
      displayName: '研究模式',
      description: '专注研究的独立空间',
    };
    expect(template.name).toBe('research');
    expect(template.displayName).toBe('研究模式');
  });

  it('should accept template with only name', () => {
    const template: ProjectTemplate = {
      name: 'book-reader',
    };
    expect(template.name).toBe('book-reader');
    expect(template.displayName).toBeUndefined();
    expect(template.description).toBeUndefined();
  });
});

describe('ProjectTemplatesConfig', () => {
  it('should match disclaude.config.yaml format', () => {
    const config: ProjectTemplatesConfig = {
      research: {
        displayName: '研究模式',
        description: '专注研究的独立空间',
      },
      'book-reader': {
        displayName: '读书助手',
      },
    };
    expect(Object.keys(config)).toHaveLength(2);
    expect(config.research?.displayName).toBe('研究模式');
  });

  it('should accept empty config', () => {
    const config: ProjectTemplatesConfig = {};
    expect(Object.keys(config)).toHaveLength(0);
  });
});

describe('ProjectsPersistData', () => {
  it('should represent full persistence schema', () => {
    const data: ProjectsPersistData = {
      instances: {
        'my-research': {
          name: 'my-research',
          templateName: 'research',
          workingDir: '/workspace/projects/my-research',
          createdAt: '2026-04-09T10:00:00Z',
        },
      },
      chatProjectMap: {
        'oc_abc123': 'my-research',
        'oc_def456': 'my-research',
      },
    };
    expect(Object.keys(data.instances)).toHaveLength(1);
    expect(Object.keys(data.chatProjectMap)).toHaveLength(2);
  });

  it('should accept empty persistence (fresh state)', () => {
    const data: ProjectsPersistData = {
      instances: {},
      chatProjectMap: {},
    };
    expect(Object.keys(data.instances)).toHaveLength(0);
    expect(Object.keys(data.chatProjectMap)).toHaveLength(0);
  });
});

describe('CwdProvider', () => {
  it('should accept valid provider function', () => {
    const provider: CwdProvider = (chatId) => {
      if (chatId === 'oc_special') {return '/workspace/projects/special';}
      return undefined; // default
    };
    expect(provider('oc_special')).toBe('/workspace/projects/special');
    expect(provider('oc_normal')).toBeUndefined();
  });

  it('should accept provider that always returns a path', () => {
    const provider: CwdProvider = () => '/workspace';
    expect(provider('any-id')).toBe('/workspace');
  });
});

describe('ProjectManagerOptions', () => {
  it('should accept valid constructor options', () => {
    const options: ProjectManagerOptions = {
      workspaceDir: '/workspace',
      packageDir: '/app/packages/core',
      templatesConfig: {
        research: {
          displayName: '研究模式',
          description: '专注研究的独立空间',
        },
      },
    };
    expect(options.workspaceDir).toBe('/workspace');
    expect(options.packageDir).toBe('/app/packages/core');
    expect(Object.keys(options.templatesConfig!)).toHaveLength(1);
  });

  it('should accept options without templatesConfig (auto-discovery mode)', () => {
    const options: ProjectManagerOptions = {
      workspaceDir: '/workspace',
      packageDir: '/app/packages/core',
    };
    expect(options.workspaceDir).toBe('/workspace');
    expect(options.packageDir).toBe('/app/packages/core');
    expect(options.templatesConfig).toBeUndefined();
  });
});

describe('PersistedInstance', () => {
  it('should be assignable from InstanceInfo (structural compatibility)', () => {
    const info: InstanceInfo = {
      name: 'my-research',
      templateName: 'research',
      chatIds: ['oc_abc'],
      workingDir: '/workspace/projects/my-research',
      createdAt: '2026-04-09T10:00:00Z',
    };

    // PersistedInstance is a subset of InstanceInfo (minus chatIds)
    const persisted: PersistedInstance = {
      name: info.name,
      templateName: info.templateName,
      workingDir: info.workingDir,
      createdAt: info.createdAt,
    };
    expect(persisted.name).toBe(info.name);
    expect(persisted.templateName).toBe(info.templateName);
  });
});
