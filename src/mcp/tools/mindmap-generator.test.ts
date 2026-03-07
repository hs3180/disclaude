/**
 * Tests for mindmap generator tool.
 *
 * @module mcp/tools/mindmap-generator.test
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { generate_mindmap, generate_mindmap_from_outline } from './mindmap-generator.js';

describe('generate_mindmap', () => {
  it('should generate a simple mermaid mindmap', async () => {
    const result = await generate_mindmap({
      topic: 'Test Topic',
      branches: [
        { text: 'Branch 1' },
        { text: 'Branch 2' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.mindmap).toContain('mindmap');
    expect(result.mindmap).toContain('root((Test Topic))');
    expect(result.mindmap).toContain('Branch 1');
    expect(result.mindmap).toContain('Branch 2');
  });

  it('should generate mindmap with nested children', async () => {
    const result = await generate_mindmap({
      topic: 'Root',
      branches: [
        {
          text: 'Parent',
          children: [
            { text: 'Child 1' },
            { text: 'Child 2' },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.mindmap).toContain('Parent');
    expect(result.mindmap).toContain('Child 1');
    expect(result.mindmap).toContain('Child 2');
  });

  it('should generate markmap format when specified', async () => {
    const result = await generate_mindmap({
      topic: 'Test Topic',
      branches: [
        { text: 'Branch 1' },
      ],
      format: 'markmap',
    });

    expect(result.success).toBe(true);
    expect(result.mindmap).toContain('# Test Topic');
    expect(result.mindmap).toContain('- Branch 1');
    expect(result.mindmap).not.toContain('```mermaid');
  });

  it('should escape special characters in mermaid', async () => {
    const result = await generate_mindmap({
      topic: 'Test (Topic)',
      branches: [
        { text: 'Branch [with] special {chars}' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.mindmap).toContain('\\(');
    expect(result.mindmap).toContain('\\)');
    expect(result.mindmap).toContain('\\[');
    expect(result.mindmap).toContain('\\]');
  });

  it('should fail with empty topic', async () => {
    const result = await generate_mindmap({
      topic: '',
      branches: [{ text: 'Branch' }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Topic cannot be empty');
  });

  it('should fail with empty branches', async () => {
    const result = await generate_mindmap({
      topic: 'Test',
      branches: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Branches array cannot be empty');
  });

  it('should save to file when saveToFile is specified', async () => {
    const tempDir = `/tmp/mindmap-test-${Date.now()}`;
    await fs.mkdir(tempDir, { recursive: true });
    const filePath = path.join(tempDir, 'test-mindmap.md');

    const result = await generate_mindmap({
      topic: 'Test Topic',
      branches: [{ text: 'Branch 1' }],
      saveToFile: filePath,
    });

    expect(result.success).toBe(true);
    expect(result.filePath).toBe(filePath);

    // Verify file was created
    const fileContent = await fs.readFile(filePath, 'utf-8');
    expect(fileContent).toContain('Test Topic');

    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

describe('generate_mindmap_from_outline', () => {
  it('should parse simple outline', async () => {
    const outline = `
# Topic 1
- Point 1.1
- Point 1.2
# Topic 2
- Point 2.1
`;

    const result = await generate_mindmap_from_outline({
      title: 'Test Outline',
      outline,
    });

    expect(result.success).toBe(true);
    expect(result.mindmap).toContain('root((Test Outline))');
    expect(result.mindmap).toContain('Topic 1');
    expect(result.mindmap).toContain('Topic 2');
    expect(result.mindmap).toContain('Point 1.1');
    expect(result.mindmap).toContain('Point 2.1');
  });

  it('should parse outline with subtopics', async () => {
    const outline = `
# Main Topic
## Subtopic A
- Point A1
- Point A2
## Subtopic B
- Point B1
`;

    const result = await generate_mindmap_from_outline({
      title: 'Nested Outline',
      outline,
    });

    expect(result.success).toBe(true);
    expect(result.mindmap).toContain('Main Topic');
    expect(result.mindmap).toContain('Subtopic A');
    expect(result.mindmap).toContain('Subtopic B');
    expect(result.mindmap).toContain('Point A1');
    expect(result.mindmap).toContain('Point B1');
  });

  it('should handle asterisk as bullet point', async () => {
    const outline = `
# Topic
* Point with asterisk
`;

    const result = await generate_mindmap_from_outline({
      title: 'Asterisk Test',
      outline,
    });

    expect(result.success).toBe(true);
    expect(result.mindmap).toContain('Point with asterisk');
  });

  it('should fail with empty outline', async () => {
    const result = await generate_mindmap_from_outline({
      title: 'Empty',
      outline: '',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not parse any topics');
  });

  it('should fail with outline without topics', async () => {
    const result = await generate_mindmap_from_outline({
      title: 'No Topics',
      outline: '- Just a bullet\n- Another bullet',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not parse any topics');
  });

  it('should generate markmap format', async () => {
    const outline = `
# Topic 1
- Point 1
`;

    const result = await generate_mindmap_from_outline({
      title: 'Markmap Test',
      outline,
      format: 'markmap',
    });

    expect(result.success).toBe(true);
    expect(result.mindmap).toContain('# Markmap Test');
    expect(result.mindmap).toContain('- Topic 1');
    expect(result.mindmap).toContain('- Point 1');
  });
});
