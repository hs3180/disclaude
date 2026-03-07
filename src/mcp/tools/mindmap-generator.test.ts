/**
 * Tests for Mind Map Generator Tool.
 *
 * @module mcp/tools/mindmap-generator.test
 */

import { describe, it, expect } from 'vitest';
import {
  generate_mindmap,
  generate_mindmap_prompt,
  type MindmapGeneratorOptions,
} from './mindmap-generator.js';

const sampleContent = `
# Project Overview

This document describes the main features of our project.

## Feature A

Feature A provides core functionality for the application.

### Sub-feature A1
Description of sub-feature A1.

### Sub-feature A2
Description of sub-feature A2.

## Feature B

Feature B handles user authentication and authorization.

### Authentication
- OAuth 2.0 support
- JWT tokens
- Session management

### Authorization
- Role-based access control
- Permission management

## Feature C

Feature C manages data processing and storage.

- Data ingestion
- Data transformation
- Data export
`;

const simpleContent = `
# Main Topic

## Branch 1
- Item 1.1
- Item 1.2

## Branch 2
- Item 2.1
- Item 2.2

## Branch 3
- Item 3.1
`;

describe('generate_mindmap', () => {
  describe('basic functionality', () => {
    it('should generate a mermaid mindmap with default options', () => {
      const result = generate_mindmap({ content: sampleContent });

      expect(result.success).toBe(true);
      expect(result.mermaid).toBeDefined();
      expect(result.mermaid).toContain('mindmap');
      expect(result.mermaid).toContain('root');
      expect(result.nodes).toBeDefined();
    });

    it('should generate a markmap mindmap when format is markmap', () => {
      const options: MindmapGeneratorOptions = {
        content: sampleContent,
        format: 'markmap',
      };
      const result = generate_mindmap(options);

      expect(result.success).toBe(true);
      expect(result.markmap).toBeDefined();
      expect(result.markmap).toContain('#');
      expect(result.mermaid).toBeUndefined();
    });

    it('should generate both formats when format is both', () => {
      const options: MindmapGeneratorOptions = {
        content: sampleContent,
        format: 'both',
      };
      const result = generate_mindmap(options);

      expect(result.success).toBe(true);
      expect(result.mermaid).toBeDefined();
      expect(result.markmap).toBeDefined();
    });
  });

  describe('title customization', () => {
    it('should use custom title for root node', () => {
      const options: MindmapGeneratorOptions = {
        content: simpleContent,
        title: 'Custom Title',
      };
      const result = generate_mindmap(options);

      expect(result.success).toBe(true);
      expect(result.mermaid).toContain('Custom Title');
      expect(result.nodes?.text).toBe('Custom Title');
    });
  });

  describe('depth control', () => {
    it('should respect maxDepth parameter', () => {
      const options: MindmapGeneratorOptions = {
        content: sampleContent,
        maxDepth: 2,
      };
      const result = generate_mindmap(options);

      expect(result.success).toBe(true);
      expect(result.nodes).toBeDefined();
    });

    it('should respect maxNodesPerLevel parameter', () => {
      const options: MindmapGeneratorOptions = {
        content: sampleContent,
        maxNodesPerLevel: 3,
      };
      const result = generate_mindmap(options);

      expect(result.success).toBe(true);
      expect(result.nodes).toBeDefined();
    });
  });

  describe('structure extraction', () => {
    it('should extract structure from markdown headings', () => {
      const result = generate_mindmap({ content: sampleContent });

      expect(result.success).toBe(true);
      expect(result.nodes?.children).toBeDefined();
      expect(result.nodes?.children?.length).toBeGreaterThan(0);
    });

    it('should handle content without headings', () => {
      const plainContent = 'This is plain text without any structure. It has multiple sentences. Each sentence should become a node.';
      const result = generate_mindmap({ content: plainContent });

      expect(result.success).toBe(true);
      expect(result.nodes?.children).toBeDefined();
      expect(result.nodes?.children?.length).toBeGreaterThan(0);
    });

    it('should extract list items as children', () => {
      const listContent = `
# Main
## Section
- Item 1
- Item 2
- Item 3
`;
      const result = generate_mindmap({ content: listContent });

      expect(result.success).toBe(true);
      // Structure: root -> Main -> Section -> [Item 1, Item 2, Item 3]
      const mainNode = result.nodes?.children?.[0];
      const sectionNode = mainNode?.children?.[0];
      expect(sectionNode?.children?.length).toBe(3);
      expect(sectionNode?.children?.map(c => c.text)).toEqual(['Item 1', 'Item 2', 'Item 3']);
    });
  });

  describe('error handling', () => {
    it('should fail with empty content', () => {
      const result = generate_mindmap({ content: '' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should fail with whitespace-only content', () => {
      const result = generate_mindmap({ content: '   \n\t  ' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });
  });

  describe('output format validation', () => {
    it('should generate valid mermaid syntax', () => {
      const result = generate_mindmap({ content: sampleContent });

      expect(result.success).toBe(true);
      expect(result.mermaid).toMatch(/^mindmap\n/);
      expect(result.mermaid).toMatch(/root\(\(.*\)\)/);
    });

    it('should generate valid markdown headings for markmap', () => {
      const result = generate_mindmap({ content: sampleContent, format: 'markmap' });

      expect(result.success).toBe(true);
      expect(result.markmap).toMatch(/^# .+\n/);
    });
  });
});

describe('generate_mindmap_prompt', () => {
  it('should generate a prompt template', () => {
    const prompt = generate_mindmap_prompt(sampleContent);

    expect(prompt).toContain('Mind Map Generation Request');
    expect(prompt).toContain(sampleContent.slice(0, 50));
    expect(prompt).toContain('mermaid');
    expect(prompt).toContain('mindmap');
  });

  it('should include title if provided', () => {
    const prompt = generate_mindmap_prompt(sampleContent, 'My Project');

    expect(prompt).toContain('My Project');
    expect(prompt).toContain('Title');
  });

  it('should not include title section if not provided', () => {
    const prompt = generate_mindmap_prompt(sampleContent);

    expect(prompt).not.toContain('**Title**');
  });
});
