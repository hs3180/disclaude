/**
 * Unit tests for ResearchMode module (Issue #1709)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  ResearchModeService,
  validateTopic,
  DEFAULT_RESEARCH_SOUL,
  DEFAULT_RESEARCH_SKILLS,
} from './research-mode.js';

describe('ResearchMode', () => {
  let tempDir: string;
  let service: ResearchModeService;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-mode-test-'));
    service = new ResearchModeService(tempDir);
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ===========================================================================
  // validateTopic
  // ===========================================================================
  describe('validateTopic', () => {
    it('should accept valid topic names', () => {
      expect(validateTopic('ai-safety')).toBeUndefined();
      expect(validateTopic('climate-change')).toBeUndefined();
      expect(validateTopic('2024-review')).toBeUndefined();
      expect(validateTopic('deep_learning')).toBeUndefined();
    });

    it('should reject empty topics', () => {
      expect(validateTopic('')).toBe('Topic must not be empty');
      expect(validateTopic('   ')).toBe('Topic must not be empty');
    });

    it('should reject topics with path separators', () => {
      expect(validateTopic('foo/bar')).toBe('Topic must not contain path separators');
      expect(validateTopic('foo\\bar')).toBe('Topic must not contain path separators');
    });

    it('should reject topics starting or ending with dot', () => {
      expect(validateTopic('.hidden')).toBe('Topic must not start or end with a dot');
      expect(validateTopic('trailing.')).toBe('Topic must not start or end with a dot');
    });

    it('should reject topics with null bytes', () => {
      expect(validateTopic('foo\0bar')).toBe('Topic must not contain null bytes');
    });

    it('should reject topics with leading/trailing whitespace', () => {
      expect(validateTopic(' topic')).toBe('Topic must not have leading or trailing whitespace');
      expect(validateTopic('topic ')).toBe('Topic must not have leading or trailing whitespace');
    });
  });

  // ===========================================================================
  // ResearchModeService - Initial State
  // ===========================================================================
  describe('initial state', () => {
    it('should start in normal mode', () => {
      expect(service.getMode()).toBe('normal');
      expect(service.isResearchMode()).toBe(false);
    });

    it('should return correct initial state snapshot', () => {
      const state = service.getState();
      expect(state).toEqual({
        mode: 'normal',
        cwd: tempDir,
      });
    });

    it('should return empty SDK options in normal mode', () => {
      const extra = service.getSdkOptionsExtra();
      expect(extra).toEqual({});
    });

    it('should return undefined soul content in normal mode', () => {
      expect(service.getSoulContent()).toBeUndefined();
    });

    it('should return undefined research dir in normal mode', () => {
      expect(service.getResearchDir()).toBeUndefined();
    });
  });

  // ===========================================================================
  // ResearchModeService - Activation
  // ===========================================================================
  describe('activate', () => {
    it('should activate research mode with a topic', async () => {
      const researchDir = await service.activate({ topic: 'ai-safety' });

      expect(service.getMode()).toBe('research');
      expect(service.isResearchMode()).toBe(true);
      expect(researchDir).toContain('ai-safety');
    });

    it('should create research directory', async () => {
      const researchDir = await service.activate({ topic: 'test-topic' });

      // Verify directory exists
      const stat = await fs.stat(researchDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should save RESEARCH_SOUL.md in research directory', async () => {
      await service.activate({ topic: 'test-topic' });

      const soulPath = path.join(tempDir, 'research', 'test-topic', 'RESEARCH_SOUL.md');
      const content = await fs.readFile(soulPath, 'utf-8');
      expect(content).toBe(DEFAULT_RESEARCH_SOUL);
    });

    it('should use custom soul content when provided', async () => {
      const customSoul = '# Custom Research Soul\n\nBe thorough.';
      await service.activate({ topic: 'test', soulContent: customSoul });

      const soulPath = path.join(tempDir, 'research', 'test', 'RESEARCH_SOUL.md');
      const content = await fs.readFile(soulPath, 'utf-8');
      expect(content).toBe(customSoul);
    });

    it('should use custom research dir when provided', async () => {
      const customDir = path.join(tempDir, 'custom-research');
      const researchDir = await service.activate({
        topic: 'test',
        researchDir: customDir,
      });

      expect(researchDir).toBe(customDir);
      const stat = await fs.stat(customDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should throw on invalid topic', async () => {
      await expect(service.activate({ topic: '' }))
        .rejects.toThrow('Invalid research topic');
      await expect(service.activate({ topic: 'foo/bar' }))
        .rejects.toThrow('Invalid research topic');
    });

    it('should return correct state after activation', async () => {
      await service.activate({ topic: 'my-research' });

      const state = service.getState();
      expect(state.mode).toBe('research');
      expect(state.topic).toBe('my-research');
      expect(state.cwd).toContain('my-research');
      expect(state.soulContent).toBe(DEFAULT_RESEARCH_SOUL);
      expect(state.allowedSkills).toEqual(DEFAULT_RESEARCH_SKILLS);
    });
  });

  // ===========================================================================
  // ResearchModeService - SDK Options
  // ===========================================================================
  describe('getSdkOptionsExtra', () => {
    it('should return cwd override in research mode', async () => {
      await service.activate({ topic: 'test' });
      const extra = service.getSdkOptionsExtra();

      expect(extra.cwd).toContain('test');
    });

    it('should return default research skills as allowedTools', async () => {
      await service.activate({ topic: 'test' });
      const extra = service.getSdkOptionsExtra();

      expect(extra.allowedTools).toEqual(DEFAULT_RESEARCH_SKILLS);
    });

    it('should use custom allowed skills when provided', async () => {
      const customSkills = ['web-search', 'note-taker'];
      await service.activate({ topic: 'test', allowedSkills: customSkills });
      const extra = service.getSdkOptionsExtra();

      expect(extra.allowedTools).toEqual(customSkills);
    });

    it('should return empty object when allowedSkills is empty array', async () => {
      await service.activate({ topic: 'test', allowedSkills: [] });
      const extra = service.getSdkOptionsExtra();

      // cwd should still be set, but no allowedTools
      expect(extra.cwd).toBeDefined();
      expect(extra.allowedTools).toBeUndefined();
    });
  });

  // ===========================================================================
  // ResearchModeService - SOUL Content
  // ===========================================================================
  describe('getSoulContent', () => {
    it('should return default soul content in research mode', async () => {
      await service.activate({ topic: 'test' });
      const soul = service.getSoulContent();

      expect(soul).toBe(DEFAULT_RESEARCH_SOUL);
      expect(soul).toContain('Research Behavior Guidelines');
    });

    it('should return custom soul content when provided', async () => {
      const custom = '# Custom SOUL';
      await service.activate({ topic: 'test', soulContent: custom });
      const soul = service.getSoulContent();

      expect(soul).toBe(custom);
    });
  });

  // ===========================================================================
  // ResearchModeService - Deactivation
  // ===========================================================================
  describe('deactivate', () => {
    it('should return to normal mode', async () => {
      await service.activate({ topic: 'test' });
      expect(service.isResearchMode()).toBe(true);

      service.deactivate();
      expect(service.getMode()).toBe('normal');
      expect(service.isResearchMode()).toBe(false);
    });

    it('should clear research state', async () => {
      await service.activate({ topic: 'test' });
      service.deactivate();

      expect(service.getSoulContent()).toBeUndefined();
      expect(service.getResearchDir()).toBeUndefined();
      expect(service.getSdkOptionsExtra()).toEqual({});
    });

    it('should not delete research directory on deactivate', async () => {
      await service.activate({ topic: 'test' });
      const researchDir = service.getResearchDir()!;
      service.deactivate();

      // Directory should still exist
      const stat = await fs.stat(researchDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should be safe to call deactivate when already in normal mode', () => {
      // Should not throw
      service.deactivate();
      service.deactivate();
      expect(service.getMode()).toBe('normal');
    });
  });

  // ===========================================================================
  // ResearchModeService - getResearchDirForTopic
  // ===========================================================================
  describe('getResearchDirForTopic', () => {
    it('should return correct path for a topic', () => {
      const result = service.getResearchDirForTopic('my-topic');
      expect(result).toBe(path.join(tempDir, 'research', 'my-topic'));
    });
  });

  // ===========================================================================
  // ResearchModeService - Mode Switching
  // ===========================================================================
  describe('mode switching', () => {
    it('should support multiple activate/deactivate cycles', async () => {
      // First cycle
      await service.activate({ topic: 'topic-a' });
      expect(service.isResearchMode()).toBe(true);
      expect(service.getState().topic).toBe('topic-a');

      service.deactivate();
      expect(service.isResearchMode()).toBe(false);

      // Second cycle with different topic
      await service.activate({ topic: 'topic-b' });
      expect(service.isResearchMode()).toBe(true);
      expect(service.getState().topic).toBe('topic-b');

      service.deactivate();
      expect(service.isResearchMode()).toBe(false);
    });

    it('should handle activate while already in research mode', async () => {
      await service.activate({ topic: 'topic-a' });
      await service.activate({ topic: 'topic-b' });

      // Should switch to new topic
      expect(service.getState().topic).toBe('topic-b');
      expect(service.getResearchDir()).toContain('topic-b');
    });
  });
});
