/**
 * Tests for Project Configuration types and Config integration.
 * Issue #1916: Project Knowledge Base feature.
 */

import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_FILE_EXTENSIONS, DEFAULT_MAX_KNOWLEDGE_LENGTH } from './types.js';
import { buildProjectKnowledgeSection } from '../agents/message-builder/guidance.js';

describe('project types', () => {
  describe('KNOWLEDGE_FILE_EXTENSIONS', () => {
    it('should include common text formats', () => {
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.md')).toBe(true);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.txt')).toBe(true);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.json')).toBe(true);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.yaml')).toBe(true);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.ts')).toBe(true);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.js')).toBe(true);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.py')).toBe(true);
    });

    it('should not include binary formats', () => {
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.png')).toBe(false);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.jpg')).toBe(false);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.gif')).toBe(false);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.pdf')).toBe(false);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.zip')).toBe(false);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.mp3')).toBe(false);
      expect(KNOWLEDGE_FILE_EXTENSIONS.has('.mp4')).toBe(false);
    });
  });

  describe('DEFAULT_MAX_KNOWLEDGE_LENGTH', () => {
    it('should be 50000 characters', () => {
      expect(DEFAULT_MAX_KNOWLEDGE_LENGTH).toBe(50000);
    });
  });
});

describe('buildProjectKnowledgeSection', () => {
  it('should return empty string for undefined input', () => {
    expect(buildProjectKnowledgeSection(undefined)).toBe('');
  });

  it('should return empty string for empty string input', () => {
    expect(buildProjectKnowledgeSection('')).toBe('');
  });

  it('should wrap project context with separators', () => {
    const context = '## Instructions\n\nBe helpful.';

    const result = buildProjectKnowledgeSection(context);

    expect(result).toContain('---\n\n');
    expect(result).toContain(context);
    expect(result).toContain('\n\n---');
  });

  it('should preserve the content as-is', () => {
    const context = '# Title\n\nBody content with **bold** and `code`.';
    const result = buildProjectKnowledgeSection(context);

    expect(result).toContain(context);
  });
});
