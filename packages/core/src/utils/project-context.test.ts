/**
 * Tests for project context utilities.
 *
 * Issue #1506: Tests for reading CLAUDE.md from project directories
 * and formatting project context for agent prompts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readProjectClaudeMd, MAX_PROJECT_CONTEXT_SIZE } from './project-context.js';

describe('readProjectClaudeMd', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-context-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return null when CLAUDE.md does not exist', async () => {
    const result = await readProjectClaudeMd(tempDir);
    expect(result).toBeNull();
  });

  it('should return content when CLAUDE.md exists', async () => {
    const content = '# My Project\n\nThis is a test project.';
    await fs.writeFile(path.join(tempDir, 'CLAUDE.md'), content, 'utf-8');

    const result = await readProjectClaudeMd(tempDir);
    expect(result).toBe(content);
  });

  it('should handle empty CLAUDE.md', async () => {
    await fs.writeFile(path.join(tempDir, 'CLAUDE.md'), '', 'utf-8');

    const result = await readProjectClaudeMd(tempDir);
    expect(result).toBe('');
  });

  it('should return content within size limit', async () => {
    const content = 'A'.repeat(1000);
    await fs.writeFile(path.join(tempDir, 'CLAUDE.md'), content, 'utf-8');

    const result = await readProjectClaudeMd(tempDir);
    expect(result).toBe(content);
    expect(result?.length).toBe(1000);
  });

  it('should truncate content exceeding size limit and add warning', async () => {
    const content = 'A'.repeat(MAX_PROJECT_CONTEXT_SIZE + 1000);
    await fs.writeFile(path.join(tempDir, 'CLAUDE.md'), content, 'utf-8');

    const result = await readProjectClaudeMd(tempDir);
    expect(result).not.toBeNull();
    // Should be truncated to MAX_PROJECT_CONTEXT_SIZE + warning message
    expect(result!.length).toBeGreaterThan(MAX_PROJECT_CONTEXT_SIZE);
    expect(result).toContain('truncated');
    expect(result).toContain(String(MAX_PROJECT_CONTEXT_SIZE));
    // The truncated content should start with the original content
    expect(result!.startsWith('A'.repeat(100))).toBe(true);
  });

  it('should return null for non-existent directory', async () => {
    const result = await readProjectClaudeMd('/non/existent/directory');
    expect(result).toBeNull();
  });

  it('should read CLAUDE.md with typical project content', async () => {
    const content = `# Project Guidelines

## Commands
\`\`\`bash
npm run build
npm test
\`\`\`

## Coding Standards
- Use TypeScript strict mode
- Follow existing patterns`;
    await fs.writeFile(path.join(tempDir, 'CLAUDE.md'), content, 'utf-8');

    const result = await readProjectClaudeMd(tempDir);
    expect(result).toContain('Project Guidelines');
    expect(result).toContain('npm run build');
    expect(result).toContain('Coding Standards');
  });
});

describe('MAX_PROJECT_CONTEXT_SIZE', () => {
  it('should be 32KB', () => {
    expect(MAX_PROJECT_CONTEXT_SIZE).toBe(32 * 1024);
  });
});
