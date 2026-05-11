/**
 * Type-level tests for ProjectManager types.
 *
 * Since types.ts is pure type definitions (no runtime logic),
 * these tests verify structural correctness through runtime type guards
 * and discriminated union behavior.
 *
 * @see Issue #2223
 * @see Issue #3519 (simplified /project command)
 */

import { describe, it, expect } from 'vitest';
import type {
  CwdProvider,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
} from './types.js';

describe('ProjectResult<T> discriminated union', () => {
  it('should accept success result', () => {
    const result: ProjectResult<ProjectContextConfig> = {
      ok: true,
      data: {
        name: 'my-research',
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
      error: '目录不存在',
    };
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('目录不存在');
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
});

describe('ProjectContextConfig', () => {
  it('should accept default config', () => {
    const config: ProjectContextConfig = {
      name: 'default',
      workingDir: '/workspace',
    };
    expect(config.name).toBe('default');
    expect(config.workingDir).toBe('/workspace');
  });

  it('should accept bound project config', () => {
    const config: ProjectContextConfig = {
      name: 'my-research',
      workingDir: '/workspace/projects/my-research',
    };
    expect(config.name).toBe('my-research');
    expect(config.workingDir).toBe('/workspace/projects/my-research');
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
    };
    expect(options.workspaceDir).toBe('/workspace');
  });
});
