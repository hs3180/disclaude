/**
 * Unit tests for Agent Mode module.
 *
 * Issue #1709: Research Mode Phase 1 - Mode switching framework.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveModeConfig,
  isValidResearchTopic,
  getResearchWorkspaceDir,
  type ResearchModeOptions,
} from './mode.js';

// Mock Config to avoid dependency on environment
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/test-workspace'),
  },
}));

describe('resolveModeConfig', () => {
  describe('normal mode', () => {
    it('should resolve normal mode with workspace dir', () => {
      const config = resolveModeConfig('normal');

      expect(config.mode).toBe('normal');
      expect(config.cwd).toBe('/test-workspace');
      expect(config.soulSkillName).toBeUndefined();
    });

    it('should ignore options for normal mode', () => {
      const config = resolveModeConfig('normal', { topic: 'ignored' } as ResearchModeOptions);

      expect(config.mode).toBe('normal');
      expect(config.cwd).toBe('/test-workspace');
    });
  });

  describe('research mode', () => {
    it('should resolve research mode with topic subdirectory', () => {
      const config = resolveModeConfig('research', { topic: 'ai-safety' });

      expect(config.mode).toBe('research');
      expect(config.cwd).toBe('/test-workspace/research/ai-safety');
      expect(config.soulSkillName).toBe('research-soul');
    });

    it('should use default topic when not specified', () => {
      const config = resolveModeConfig('research');

      expect(config.mode).toBe('research');
      expect(config.cwd).toBe('/test-workspace/research/default');
      expect(config.soulSkillName).toBe('research-soul');
    });

    it('should handle topic with hyphens', () => {
      const config = resolveModeConfig('research', { topic: 'web-performance' });

      expect(config.cwd).toBe('/test-workspace/research/web-performance');
    });

    it('should handle topic with underscores', () => {
      const config = resolveModeConfig('research', { topic: 'react_hooks' });

      expect(config.cwd).toBe('/test-workspace/research/react_hooks');
    });

    it('should handle topic with dots', () => {
      const config = resolveModeConfig('research', { topic: 'React.18' });

      expect(config.cwd).toBe('/test-workspace/research/React.18');
    });
  });
});

describe('isValidResearchTopic', () => {
  it('should accept valid topic names', () => {
    expect(isValidResearchTopic('ai-safety')).toBe(true);
    expect(isValidResearchTopic('web_performance')).toBe(true);
    expect(isValidResearchTopic('React.18')).toBe(true);
    expect(isValidResearchTopic('test')).toBe(true);
    expect(isValidResearchTopic('a')).toBe(true);
    expect(isValidResearchTopic('a'.repeat(100))).toBe(true);
  });

  it('should reject empty topics', () => {
    expect(isValidResearchTopic('')).toBe(false);
  });

  it('should reject topics with spaces', () => {
    expect(isValidResearchTopic('topic with spaces')).toBe(false);
    expect(isValidResearchTopic(' leading')).toBe(false);
    expect(isValidResearchTopic('trailing ')).toBe(false);
  });

  it('should reject topics with path traversal', () => {
    expect(isValidResearchTopic('../escape')).toBe(false);
    expect(isValidResearchTopic('topic/../../etc')).toBe(false);
    expect(isValidResearchTopic('./hidden')).toBe(false);
  });

  it('should reject topics with special characters', () => {
    expect(isValidResearchTopic('topic!')).toBe(false);
    expect(isValidResearchTopic('topic@')).toBe(false);
    expect(isValidResearchTopic('topic#')).toBe(false);
    expect(isValidResearchTopic('topic$')).toBe(false);
    expect(isValidResearchTopic('topic%')).toBe(false);
    expect(isValidResearchTopic('topic name')).toBe(false);
  });

  it('should reject overly long topics', () => {
    expect(isValidResearchTopic('a'.repeat(101))).toBe(false);
  });

  it('should accept exactly 100 characters', () => {
    expect(isValidResearchTopic('a'.repeat(100))).toBe(true);
  });
});

describe('getResearchWorkspaceDir', () => {
  it('should construct correct path with topic and custom workspace', () => {
    const result = getResearchWorkspaceDir('my-topic', '/workspace');
    expect(result).toBe('/workspace/research/my-topic');
  });

  it('should construct correct path with nested topic', () => {
    const result = getResearchWorkspaceDir('deep-topic', '/app/data');
    expect(result).toBe('/app/data/research/deep-topic');
  });

  it('should use Config.getWorkspaceDir when workspaceDir not provided', () => {
    const result = getResearchWorkspaceDir('auto-topic');
    expect(result).toBe('/test-workspace/research/auto-topic');
  });
});
