/**
 * Tests for agents/mode.ts
 *
 * Tests the agent mode switching framework:
 * - ModeManager: mode state management and path resolution
 * - sanitizeTopicName: topic name sanitization for filesystem safety
 * - isResearchWorkspace: research workspace detection
 * - Research workspace setup
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ModeManager,
  sanitizeTopicName,
  isResearchWorkspace,
} from './mode.js';

const DEFAULT_TOPIC = 'default';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockedFs = vi.mocked(fs);

describe('ModeManager', () => {
  const workspaceDir = '/test/workspace';

  describe('constructor', () => {
    it('should default to normal mode when no mode is specified', () => {
      const manager = new ModeManager({ workspaceDir });
      expect(manager.getMode()).toBe('normal');
      expect(manager.isResearchMode()).toBe(false);
    });

    it('should accept explicit normal mode', () => {
      const manager = new ModeManager({ mode: 'normal', workspaceDir });
      expect(manager.getMode()).toBe('normal');
      expect(manager.isResearchMode()).toBe(false);
    });

    it('should accept research mode', () => {
      const manager = new ModeManager({ mode: 'research', workspaceDir });
      expect(manager.getMode()).toBe('research');
      expect(manager.isResearchMode()).toBe(true);
    });

    it('should store research config', () => {
      const manager = new ModeManager({
        mode: 'research',
        workspaceDir,
        researchConfig: { topic: 'test-topic', baseDir: '/custom/research' },
      });
      expect(manager.getMode()).toBe('research');
    });
  });

  describe('resolve', () => {
    it('should return workspace dir for normal mode', () => {
      const manager = new ModeManager({ mode: 'normal', workspaceDir });
      const config = manager.resolve();

      expect(config.mode).toBe('normal');
      expect(config.cwd).toBe(workspaceDir);
      expect(config.hasCustomCwd).toBe(false);
    });

    it('should return research workspace path for research mode', () => {
      const manager = new ModeManager({
        mode: 'research',
        workspaceDir,
        researchConfig: { topic: 'my-research' },
      });
      const config = manager.resolve();

      expect(config.mode).toBe('research');
      expect(config.cwd).toBe(path.join(workspaceDir, 'research', 'my-research'));
      expect(config.hasCustomCwd).toBe(true);
    });

    it('should use custom baseDir when provided', () => {
      const manager = new ModeManager({
        mode: 'research',
        workspaceDir,
        researchConfig: { baseDir: '/custom/base', topic: 'test' },
      });
      const config = manager.resolve();

      expect(config.cwd).toBe(path.join('/custom/base', 'test'));
    });

    it('should use default topic when none specified', () => {
      const manager = new ModeManager({ mode: 'research', workspaceDir });
      const config = manager.resolve();

      expect(config.cwd).toBe(path.join(workspaceDir, 'research', DEFAULT_TOPIC));
    });

    it('should sanitize topic name in path', () => {
      const manager = new ModeManager({
        mode: 'research',
        workspaceDir,
        researchConfig: { topic: 'React Performance!!' },
      });
      const config = manager.resolve();

      expect(config.cwd).toContain('react-performance');
    });
  });

  describe('getResearchWorkspacePath', () => {
    it('should compute correct path with default base and topic', () => {
      const manager = new ModeManager({ mode: 'research', workspaceDir });
      const researchPath = manager.getResearchWorkspacePath();

      expect(researchPath).toBe(path.join(workspaceDir, 'research', DEFAULT_TOPIC));
    });

    it('should compute correct path with custom topic', () => {
      const manager = new ModeManager({
        mode: 'research',
        workspaceDir,
        researchConfig: { topic: 'typescript-patterns' },
      });
      const researchPath = manager.getResearchWorkspacePath();

      expect(researchPath).toBe(path.join(workspaceDir, 'research', 'typescript-patterns'));
    });

    it('should compute correct path with custom baseDir', () => {
      const manager = new ModeManager({
        mode: 'research',
        workspaceDir,
        researchConfig: { baseDir: '/data/studies', topic: 'ml-basics' },
      });
      const researchPath = manager.getResearchWorkspacePath();

      expect(researchPath).toBe(path.join('/data/studies', 'ml-basics'));
    });
  });

  describe('setupResearchWorkspace', () => {
    it('should return error when not in research mode', async () => {
      const manager = new ModeManager({ mode: 'normal', workspaceDir });
      const result = await manager.setupResearchWorkspace();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not in research mode');
      expect(result.workspacePath).toBeUndefined();
    });

    it('should create workspace directory structure', async () => {
      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.access.mockRejectedValue(new Error('not found'));
      mockedFs.writeFile.mockResolvedValue(undefined);

      const manager = new ModeManager({
        mode: 'research',
        workspaceDir,
        researchConfig: { topic: 'test-setup' },
      });

      const result = await manager.setupResearchWorkspace();

      expect(result.success).toBe(true);
      expect(result.workspacePath).toBe(path.join(workspaceDir, 'research', 'test-setup'));

      // Verify mkdir was called for workspace and skills
      expect(mockedFs.mkdir).toHaveBeenCalledWith(
        path.join(workspaceDir, 'research', 'test-setup'),
        { recursive: true }
      );
      expect(mockedFs.mkdir).toHaveBeenCalledWith(
        path.join(workspaceDir, 'research', 'test-setup', '.claude', 'skills'),
        { recursive: true }
      );

      // Verify CLAUDE.md was written
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        path.join(workspaceDir, 'research', 'test-setup', 'CLAUDE.md'),
        expect.stringContaining('# Research Mode'),
        'utf-8'
      );
    });

    it('should skip CLAUDE.md creation if it already exists', async () => {
      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.access.mockResolvedValue(undefined); // File exists
      mockedFs.writeFile.mockClear(); // Clear previous test's calls

      const manager = new ModeManager({
        mode: 'research',
        workspaceDir,
        researchConfig: { topic: 'existing' },
      });

      const result = await manager.setupResearchWorkspace();

      expect(result.success).toBe(true);
      // writeFile should NOT be called since CLAUDE.md already exists
      expect(mockedFs.writeFile).not.toHaveBeenCalled();
    });

    it('should handle mkdir failure', async () => {
      mockedFs.mkdir.mockRejectedValue(new Error('Permission denied'));

      const manager = new ModeManager({
        mode: 'research',
        workspaceDir,
        researchConfig: { topic: 'fail-test' },
      });

      const result = await manager.setupResearchWorkspace();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });
  });
});

describe('sanitizeTopicName', () => {
  it('should convert to lowercase', () => {
    expect(sanitizeTopicName('REACT')).toBe('react');
  });

  it('should replace spaces with hyphens', () => {
    expect(sanitizeTopicName('react performance')).toBe('react-performance');
  });

  it('should remove special characters', () => {
    expect(sanitizeTopicName('React Performance!!')).toBe('react-performance');
  });

  it('should handle multiple spaces', () => {
    expect(sanitizeTopicName('react   performance   test')).toBe('react-performance-test');
  });

  it('should trim whitespace', () => {
    expect(sanitizeTopicName('  react  ')).toBe('react');
  });

  it('should allow hyphens and underscores', () => {
    expect(sanitizeTopicName('react_v2-performance')).toBe('react_v2-performance');
  });

  it('should allow numbers', () => {
    expect(sanitizeTopicName('react-19-analysis')).toBe('react-19-analysis');
  });

  it('should limit length to 64 characters', () => {
    const longTopic = 'a'.repeat(100);
    expect(sanitizeTopicName(longTopic)).toHaveLength(64);
  });

  it('should handle C++ style names', () => {
    expect(sanitizeTopicName('C++ Memory Management')).toBe('c-memory-management');
  });

  it('should handle empty string', () => {
    expect(sanitizeTopicName('')).toBe('');
  });

  it('should handle only special characters', () => {
    expect(sanitizeTopicName('!!!@@@###')).toBe('');
  });
});

describe('isResearchWorkspace', () => {
  it('should return true if CLAUDE.md contains Research Mode header', async () => {
    mockedFs.readFile.mockResolvedValue('# Research Mode\n\nSome content');

    const result = await isResearchWorkspace('/test/research');

    expect(result).toBe(true);
    expect(mockedFs.readFile).toHaveBeenCalledWith(
      path.join('/test/research', 'CLAUDE.md'),
      'utf-8'
    );
  });

  it('should return false if CLAUDE.md does not contain Research Mode header', async () => {
    mockedFs.readFile.mockResolvedValue('# Normal Project\n\nSome content');

    const result = await isResearchWorkspace('/test/workspace');

    expect(result).toBe(false);
  });

  it('should return false if CLAUDE.md does not exist', async () => {
    mockedFs.readFile.mockRejectedValue(new Error('ENOENT'));

    const result = await isResearchWorkspace('/test/empty');

    expect(result).toBe(false);
  });
});
