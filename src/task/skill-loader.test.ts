/**
 * Tests for skill loader (src/agent/skill-loader.ts)
 *
 * Tests the following functionality:
 * - Loading skill files from .claude/skills directory
 * - Parsing YAML frontmatter
 * - Handling missing or malformed skill files
 * - Getting MCP server configuration for skills
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import {
  loadSkill,
  loadSkillOrThrow,
} from './skill-loader.js';

// Mock fs module
vi.mock('fs/promises');
const mockedFs = vi.mocked(fs);

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getSkillsDir: () => '/mock/skills/dir',
  },
}));

describe('loadSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load skill with valid frontmatter', async () => {
    const skillContent = `---
name: test-skill
description: A test skill
disable-model-invocation: true
allowed-tools: Read,Write,Glob
---

# Test Skill Content

This is the skill content.
`;

    mockedFs.readFile.mockResolvedValueOnce(skillContent);

    const result = await loadSkill('test-skill');

    expect(result.success).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill?.name).toBe('test-skill');
    expect(result.skill?.description).toBe('A test skill');
    expect(result.skill?.disableModelInvocation).toBe(true);
    expect(result.skill?.allowedTools).toEqual(['Read', 'Write', 'Glob']);
    expect(result.skill?.content).toContain('# Test Skill Content');
  });

  it('should parse array format for allowed-tools', async () => {
    const skillContent = `---
name: test-skill
description: A test skill
allowed-tools: [Read, Write, Glob]
---

# Content
`;

    mockedFs.readFile.mockResolvedValueOnce(skillContent);

    const result = await loadSkill('test-skill');

    expect(result.success).toBe(true);
    expect(result.skill?.allowedTools).toEqual(['Read', 'Write', 'Glob']);
  });

  it('should handle skill without frontmatter', async () => {
    const skillContent = `# Skill Content

No frontmatter here.
`;

    mockedFs.readFile.mockResolvedValueOnce(skillContent);

    const result = await loadSkill('test-skill');

    expect(result.success).toBe(true);
    expect(result.skill?.name).toBe('test-skill'); // defaults to skillName
    expect(result.skill?.description).toBe('');
    expect(result.skill?.disableModelInvocation).toBe(false);
    expect(result.skill?.allowedTools).toEqual([]);
    expect(result.skill?.content).toContain('# Skill Content');
  });

  it('should handle disable-model-invocation=false', async () => {
    const skillContent = `---
name: test-skill
disable-model-invocation: false
---

# Content
`;

    mockedFs.readFile.mockResolvedValueOnce(skillContent);

    const result = await loadSkill('test-skill');

    expect(result.success).toBe(true);
    expect(result.skill?.disableModelInvocation).toBe(false);
  });

  it('should trim whitespace from tool names', async () => {
    const skillContent = `---
name: test-skill
allowed-tools: Read , Write , Glob , Grep
---

# Content
`;

    mockedFs.readFile.mockResolvedValueOnce(skillContent);

    const result = await loadSkill('test-skill');

    expect(result.success).toBe(true);
    expect(result.skill?.allowedTools).toEqual(['Read', 'Write', 'Glob', 'Grep']);
  });

  it('should filter empty tool names', async () => {
    const skillContent = `---
name: test-skill
allowed-tools: Read,,Write,,Glob
---

# Content
`;

    mockedFs.readFile.mockResolvedValueOnce(skillContent);

    const result = await loadSkill('test-skill');

    expect(result.success).toBe(true);
    expect(result.skill?.allowedTools).toEqual(['Read', 'Write', 'Glob']);
  });

  it('should return error when file does not exist', async () => {
    const error = new Error('ENOENT: file not found');
    mockedFs.readFile.mockRejectedValueOnce(error);

    const result = await loadSkill('nonexistent-skill');

    expect(result.success).toBe(false);
    expect(result.skill).toBeUndefined();
    expect(result.error).toContain('ENOENT');
  });

  it('should return error when readFile throws', async () => {
    const error = new Error('Permission denied');
    mockedFs.readFile.mockRejectedValueOnce(error);

    const result = await loadSkill('test-skill');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Permission denied');
  });

  it('should call readFile with correct path', async () => {
    const skillContent = `---
name: test-skill
---

# Content
`;
    mockedFs.readFile.mockResolvedValueOnce(skillContent);

    await loadSkill('test-skill');

    expect(mockedFs.readFile).toHaveBeenCalledWith(
      '/mock/skills/dir/test-skill/SKILL.md',
      'utf-8'
    );
  });
});

describe('loadSkillOrThrow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return skill when loading succeeds', async () => {
    const skillContent = `---
name: test-skill
description: Test
---

# Content
`;
    vi.mocked(fs.readFile).mockResolvedValueOnce(skillContent);

    const skill = await loadSkillOrThrow('test-skill');

    expect(skill).toBeDefined();
    expect(skill.name).toBe('test-skill');
  });

  it('should throw error when loading fails', async () => {
    const error = new Error('File not found');
    vi.mocked(fs.readFile).mockRejectedValueOnce(error);

    await expect(loadSkillOrThrow('test-skill')).rejects.toThrow('Required skill "test-skill" failed to load');
  });

  it('should throw error when skill is missing', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));

    await expect(loadSkillOrThrow('missing-skill')).rejects.toThrow('missing-skill');
  });
});
