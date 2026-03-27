/**
 * Tests for research workspace manager.
 *
 * Issue #1707: Research Mode — Phase 1 (Research workspace + RESEARCH.md)
 *
 * Uses real filesystem via temp directories (no mocks for fs operations).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  getResearchRootDir,
  getResearchDir,
  getResearchFilePath,
  getResearchCwd,
  createResearchWorkspace,
  readResearchFile,
  researchWorkspaceExists,
  updateResearchFileSection,
  appendToResearchFileSection,
  parseResearchSections,
  listResearchTopics,
  RESEARCH_DIR_NAME,
  RESEARCH_FILE_NAME,
  RESEARCH_SUB_DIRS,
} from './research-manager.js';

describe('research-manager', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getResearchRootDir', () => {
    it('should return workspace/research path', () => {
      const result = getResearchRootDir(tempDir);
      expect(result).toBe(path.resolve(tempDir, RESEARCH_DIR_NAME));
    });
  });

  describe('getResearchDir', () => {
    it('should sanitize topic name for directory use', () => {
      const result = getResearchDir(tempDir, 'My Research Topic!');
      expect(result).toContain(RESEARCH_DIR_NAME);
      expect(result).toContain('my-research-topic');
      expect(result).not.toContain('!');
    });

    it('should handle CJK characters in topic', () => {
      const result = getResearchDir(tempDir, 'AI 安全研究');
      expect(result).toContain('ai-安全研究');
    });

    it('should limit topic name to 64 characters', () => {
      const longTopic = 'a'.repeat(100);
      const result = getResearchDir(tempDir, longTopic);
      const dirName = path.basename(result);
      expect(dirName.length).toBeLessThanOrEqual(64);
    });

    it('should fallback to "untitled" for empty-like input', () => {
      const result = getResearchDir(tempDir, '!!!');
      expect(result).toContain('untitled');
    });

    it('should collapse multiple hyphens', () => {
      const result = getResearchDir(tempDir, 'hello -- world');
      expect(result).toContain('hello-world');
      expect(result).not.toContain('--');
    });
  });

  describe('getResearchFilePath', () => {
    it('should return path to RESEARCH.md in topic directory', () => {
      const result = getResearchFilePath(tempDir, 'test-topic');
      expect(result).toContain(RESEARCH_DIR_NAME);
      expect(result).toContain(RESEARCH_FILE_NAME);
      expect(result).toContain('test-topic');
    });
  });

  describe('getResearchCwd', () => {
    it('should return same path as getResearchDir', () => {
      const cwd = getResearchCwd(tempDir, 'test-topic');
      const dir = getResearchDir(tempDir, 'test-topic');
      expect(cwd).toBe(dir);
    });
  });

  describe('createResearchWorkspace', () => {
    it('should create research directory structure', async () => {
      const researchDir = await createResearchWorkspace(tempDir, {
        topic: 'Test Research',
      });

      // Verify main directory exists
      const stat = await fs.stat(researchDir);
      expect(stat.isDirectory()).toBe(true);

      // Verify RESEARCH.md exists
      const researchFile = path.join(researchDir, RESEARCH_FILE_NAME);
      const content = await fs.readFile(researchFile, 'utf-8');
      expect(content).toContain('# Research: Test Research');

      // Verify sub-directories exist
      for (const subDir of RESEARCH_SUB_DIRS) {
        const subPath = path.join(researchDir, subDir);
        const subStat = await fs.stat(subPath);
        expect(subStat.isDirectory()).toBe(true);
      }
    });

    it('should include objective in RESEARCH.md when provided', async () => {
      const researchDir = await createResearchWorkspace(tempDir, {
        topic: 'AI Safety',
        objective: 'Investigate alignment techniques',
      });

      const content = await fs.readFile(
        path.join(researchDir, RESEARCH_FILE_NAME),
        'utf-8',
      );
      expect(content).toContain('## Objective');
      expect(content).toContain('Investigate alignment techniques');
    });

    it('should include context in RESEARCH.md when provided', async () => {
      const researchDir = await createResearchWorkspace(tempDir, {
        topic: 'Climate Data',
        context: 'Based on IPCC AR6 report findings',
      });

      const content = await fs.readFile(
        path.join(researchDir, RESEARCH_FILE_NAME),
        'utf-8',
      );
      expect(content).toContain('## Context');
      expect(content).toContain('Based on IPCC AR6 report findings');
    });

    it('should create default sections when no options provided', async () => {
      const researchDir = await createResearchWorkspace(tempDir, {
        topic: 'Minimal',
      });

      const content = await fs.readFile(
        path.join(researchDir, RESEARCH_FILE_NAME),
        'utf-8',
      );
      expect(content).toContain('## Findings');
      expect(content).toContain('## Questions');
      expect(content).toContain('## Sources');
      expect(content).toContain('## Conclusion');
    });

    it('should throw error for empty topic', async () => {
      await expect(
        createResearchWorkspace(tempDir, { topic: '' }),
      ).rejects.toThrow('Research topic is required');
    });

    it('should throw error for whitespace-only topic', async () => {
      await expect(
        createResearchWorkspace(tempDir, { topic: '   ' }),
      ).rejects.toThrow('Research topic is required');
    });

    it('should be idempotent (safe to call twice)', async () => {
      await createResearchWorkspace(tempDir, { topic: 'Idempotent' });
      await createResearchWorkspace(tempDir, { topic: 'Idempotent' });

      // Should not throw, directory should still exist
      const exists = await researchWorkspaceExists(tempDir, 'Idempotent');
      expect(exists).toBe(true);
    });
  });

  describe('readResearchFile', () => {
    it('should read the RESEARCH.md content', async () => {
      await createResearchWorkspace(tempDir, { topic: 'ReadTest' });
      const content = await readResearchFile(tempDir, 'ReadTest');
      expect(content).toContain('# Research: ReadTest');
    });

    it('should throw if file does not exist', async () => {
      await expect(
        readResearchFile(tempDir, 'NonExistent'),
      ).rejects.toThrow();
    });
  });

  describe('researchWorkspaceExists', () => {
    it('should return true for existing workspace', async () => {
      await createResearchWorkspace(tempDir, { topic: 'Exists' });
      expect(await researchWorkspaceExists(tempDir, 'Exists')).toBe(true);
    });

    it('should return false for non-existent workspace', async () => {
      expect(await researchWorkspaceExists(tempDir, 'Nope')).toBe(false);
    });
  });

  describe('updateResearchFileSection', () => {
    it('should replace existing section content', async () => {
      await createResearchWorkspace(tempDir, { topic: 'UpdateTest' });

      const updated = await updateResearchFileSection(
        tempDir,
        'UpdateTest',
        'Findings',
        '1. Found that X is true\n2. Y requires more investigation',
      );

      expect(updated).toContain('Found that X is true');
      expect(updated).toContain('Y requires more investigation');
      expect(updated).not.toContain('_No findings yet._');
    });

    it('should append new section if heading does not exist', async () => {
      await createResearchWorkspace(tempDir, { topic: 'NewSection' });

      const updated = await updateResearchFileSection(
        tempDir,
        'NewSection',
        'Methodology',
        'Used systematic literature review approach',
      );

      expect(updated).toContain('## Methodology');
      expect(updated).toContain('Used systematic literature review approach');
    });

    it('should match headings case-insensitively', async () => {
      await createResearchWorkspace(tempDir, { topic: 'CaseTest' });

      const updated = await updateResearchFileSection(
        tempDir,
        'CaseTest',
        'findings', // lowercase instead of "Findings"
        'Updated content',
      );

      expect(updated).toContain('Updated content');
      // Should not duplicate the section
      const sections = parseResearchSections(updated);
      const findingsCount = sections.filter(
        (s) => s.heading.toLowerCase() === 'findings',
      ).length;
      expect(findingsCount).toBe(1);
    });
  });

  describe('appendToResearchFileSection', () => {
    it('should append to existing section content', async () => {
      await createResearchWorkspace(tempDir, { topic: 'AppendTest' });

      await appendToResearchFileSection(
        tempDir,
        'AppendTest',
        'Findings',
        '- New finding A',
      );

      const content = await readResearchFile(tempDir, 'AppendTest');
      expect(content).toContain('_No findings yet._');
      expect(content).toContain('- New finding A');

      // Append again
      await appendToResearchFileSection(
        tempDir,
        'AppendTest',
        'Findings',
        '- New finding B',
      );

      const updated = await readResearchFile(tempDir, 'AppendTest');
      expect(updated).toContain('- New finding A');
      expect(updated).toContain('- New finding B');
    });

    it('should create section if it does not exist', async () => {
      await createResearchWorkspace(tempDir, { topic: 'AppendNew' });

      await appendToResearchFileSection(
        tempDir,
        'AppendNew',
        'Methodology',
        'Step 1: Define scope',
      );

      const content = await readResearchFile(tempDir, 'AppendNew');
      expect(content).toContain('## Methodology');
      expect(content).toContain('Step 1: Define scope');
    });
  });

  describe('parseResearchSections', () => {
    it('should parse all ## sections from RESEARCH.md', async () => {
      await createResearchWorkspace(tempDir, { topic: 'ParseTest' });
      const content = await readResearchFile(tempDir, 'ParseTest');
      const sections = parseResearchSections(content);

      const headings = sections.map((s) => s.heading);
      expect(headings).toContain('Findings');
      expect(headings).toContain('Questions');
      expect(headings).toContain('Sources');
      expect(headings).toContain('Conclusion');
    });

    it('should not include # (h1) headings', () => {
      const content = '# Title\n\n## Section 1\nContent\n\n## Section 2\nMore content';
      const sections = parseResearchSections(content);
      expect(sections).toHaveLength(2);
      expect(sections[0].heading).toBe('Section 1');
    });

    it('should not include ### (h3) headings as sections', () => {
      const content = '## Main\n### Sub\nContent\n\n## Other\nOther content';
      const sections = parseResearchSections(content);
      expect(sections).toHaveLength(2);
      expect(sections[0].heading).toBe('Main');
      expect(sections[0].content).toContain('### Sub');
    });

    it('should return empty array for content with no sections', () => {
      expect(parseResearchSections('No sections here')).toHaveLength(0);
    });

    it('should trim leading and trailing whitespace from section content', () => {
      const content = '## Test\n\n  Some content  \n\n  More content  \n';
      const sections = parseResearchSections(content);
      // .trim() operates on the whole block, not per-line
      expect(sections[0].content).toBe('Some content  \n\n  More content');
    });
  });

  describe('listResearchTopics', () => {
    it('should return empty array when no research workspaces exist', async () => {
      const topics = await listResearchTopics(tempDir);
      expect(topics).toEqual([]);
    });

    it('should list all research topics', async () => {
      await createResearchWorkspace(tempDir, { topic: 'Alpha' });
      await createResearchWorkspace(tempDir, { topic: 'Beta' });
      await createResearchWorkspace(tempDir, { topic: 'Gamma' });

      const topics = await listResearchTopics(tempDir);
      expect(topics).toHaveLength(3);
      expect(topics).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('should not include directories without RESEARCH.md', async () => {
      await createResearchWorkspace(tempDir, { topic: 'Valid' });

      // Create a directory without RESEARCH.md
      const researchRoot = getResearchRootDir(tempDir);
      await fs.mkdir(path.join(researchRoot, 'invalid-topic'), { recursive: true });

      const topics = await listResearchTopics(tempDir);
      expect(topics).toEqual(['valid']);
    });

    it('should return topics sorted alphabetically', async () => {
      await createResearchWorkspace(tempDir, { topic: 'Zebra' });
      await createResearchWorkspace(tempDir, { topic: 'Apple' });

      const topics = await listResearchTopics(tempDir);
      expect(topics).toEqual(['apple', 'zebra']);
    });
  });
});
