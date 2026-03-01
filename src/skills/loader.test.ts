/**
 * Tests for FileSystemSkillLoader.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileSystemSkillLoader } from './loader.js';
import type { SkillSearchPath } from './types.js';

describe('FileSystemSkillLoader', () => {
  let loader: FileSystemSkillLoader;
  let tempDir: string;

  beforeEach(async () => {
    loader = new FileSystemSkillLoader();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('loadSkill', () => {
    it('should load a skill file with frontmatter', async () => {
      const skillPath = path.join(tempDir, 'test-skill.md');
      await fs.writeFile(
        skillPath,
        `---
name: test-skill
description: A test skill
allowed-tools: [Read, Write]
---

# Test Skill

This is the skill content.`
      );

      const skill = await loader.loadSkill(skillPath);

      expect(skill.name).toBe('test-skill');
      expect(skill.description).toBe('A test skill');
      expect(skill.allowedTools).toEqual(['Read', 'Write']);
      expect(skill.content).toContain('# Test Skill');
      expect(skill.path).toBe(skillPath);
    });

    it('should load a skill file without frontmatter', async () => {
      // Create a subdirectory for the skill to test directory name extraction
      const skillDir = path.join(tempDir, 'simple-skill');
      await fs.mkdir(skillDir);
      const skillPath = path.join(skillDir, 'SKILL.md');
      await fs.writeFile(
        skillPath,
        `# Simple Skill

Just a simple skill without frontmatter.`
      );

      const skill = await loader.loadSkill(skillPath);

      expect(skill.name).toBe('simple-skill'); // Falls back to directory name
      expect(skill.description).toBeUndefined();
      expect(skill.allowedTools).toBeUndefined();
      expect(skill.content).toContain('Simple Skill');
    });

    it('should extract skill name from directory if not in frontmatter', async () => {
      const skillDir = path.join(tempDir, 'my-skill');
      await fs.mkdir(skillDir);
      const skillPath = path.join(skillDir, 'SKILL.md');
      await fs.writeFile(
        skillPath,
        `---
description: Skill without name
---

# My Skill`
      );

      const skill = await loader.loadSkill(skillPath);

      expect(skill.name).toBe('my-skill');
    });

    it('should throw error if file does not exist', async () => {
      const skillPath = path.join(tempDir, 'nonexistent.md');

      await expect(loader.loadSkill(skillPath)).rejects.toThrow();
    });
  });

  describe('loadSkillsFromDirectory', () => {
    it('should load all skills from subdirectories', async () => {
      // Create skill directories
      const evaluatorDir = path.join(tempDir, 'evaluator');
      const executorDir = path.join(tempDir, 'executor');
      await fs.mkdir(evaluatorDir);
      await fs.mkdir(executorDir);

      // Create skill files
      await fs.writeFile(
        path.join(evaluatorDir, 'SKILL.md'),
        `---
name: evaluator
description: Evaluator skill
allowed-tools: [Read, Write]
---
# Evaluator`
      );
      await fs.writeFile(
        path.join(executorDir, 'SKILL.md'),
        `---
name: executor
description: Executor skill
---
# Executor`
      );

      const skills = await loader.loadSkillsFromDirectory(tempDir);

      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name)).toContain('evaluator');
      expect(skills.map(s => s.name)).toContain('executor');
    });

    it('should skip directories without SKILL.md', async () => {
      const skillDir = path.join(tempDir, 'skill-with-file');
      const emptyDir = path.join(tempDir, 'empty-dir');
      await fs.mkdir(skillDir);
      await fs.mkdir(emptyDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: skill-with-file
---
# Skill`
      );

      const skills = await loader.loadSkillsFromDirectory(tempDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('skill-with-file');
    });

    it('should return empty array if directory does not exist', async () => {
      const skills = await loader.loadSkillsFromDirectory('/nonexistent/path');

      expect(skills).toEqual([]);
    });

    it('should skip non-directory entries', async () => {
      // Create a file (not directory) in the skills directory
      await fs.writeFile(path.join(tempDir, 'not-a-directory.md'), 'content');

      const skills = await loader.loadSkillsFromDirectory(tempDir);

      expect(skills).toEqual([]);
    });
  });

  describe('searchSkills', () => {
    it('should search skills across multiple paths', async () => {
      // Create first path with one skill
      const path1 = path.join(tempDir, 'path1');
      const skill1Dir = path.join(path1, 'skill1');
      await fs.mkdir(skill1Dir, { recursive: true });
      await fs.writeFile(
        path.join(skill1Dir, 'SKILL.md'),
        `---
name: skill1
description: Skill from path1
---
# Skill 1`
      );

      // Create second path with another skill
      const path2 = path.join(tempDir, 'path2');
      const skill2Dir = path.join(path2, 'skill2');
      await fs.mkdir(skill2Dir, { recursive: true });
      await fs.writeFile(
        path.join(skill2Dir, 'SKILL.md'),
        `---
name: skill2
description: Skill from path2
---
# Skill 2`
      );

      const searchPaths: SkillSearchPath[] = [
        { path: path1, domain: 'first', priority: 1 },
        { path: path2, domain: 'second', priority: 2 },
      ];

      const skills = await loader.searchSkills(searchPaths);

      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name)).toContain('skill1');
      expect(skills.map(s => s.name)).toContain('skill2');
    });

    it('should respect priority when skills have same name', async () => {
      // Create skill in first path
      const path1 = path.join(tempDir, 'low-priority');
      const skillDir1 = path.join(path1, 'common-skill');
      await fs.mkdir(skillDir1, { recursive: true });
      await fs.writeFile(
        path.join(skillDir1, 'SKILL.md'),
        `---
name: common-skill
description: Low priority version
---
# Low Priority`
      );

      // Create skill with same name in second path
      const path2 = path.join(tempDir, 'high-priority');
      const skillDir2 = path.join(path2, 'common-skill');
      await fs.mkdir(skillDir2, { recursive: true });
      await fs.writeFile(
        path.join(skillDir2, 'SKILL.md'),
        `---
name: common-skill
description: High priority version
---
# High Priority`
      );

      const searchPaths: SkillSearchPath[] = [
        { path: path1, domain: 'low', priority: 1 },
        { path: path2, domain: 'high', priority: 2 },
      ];

      const skills = await loader.searchSkills(searchPaths);

      // Should only have one skill (high priority wins)
      expect(skills).toHaveLength(1);
      expect(skills[0].description).toBe('High priority version');
    });

    it('should handle non-existent paths gracefully', async () => {
      const searchPaths: SkillSearchPath[] = [
        { path: '/nonexistent/path1', priority: 1 },
        { path: '/nonexistent/path2', priority: 2 },
      ];

      const skills = await loader.searchSkills(searchPaths);

      expect(skills).toEqual([]);
    });
  });

  describe('frontmatter parsing', () => {
    it('should parse allowed-tools with spaces', async () => {
      const skillPath = path.join(tempDir, 'skill.md');
      await fs.writeFile(
        skillPath,
        `---
name: spaced-tools
allowed-tools: [Read, Write, Glob]
---
# Skill`
      );

      const skill = await loader.loadSkill(skillPath);

      expect(skill.allowedTools).toEqual(['Read', 'Write', 'Glob']);
    });

    it('should handle empty allowed-tools', async () => {
      const skillPath = path.join(tempDir, 'skill.md');
      await fs.writeFile(
        skillPath,
        `---
name: empty-tools
allowed-tools: []
---
# Skill`
      );

      const skill = await loader.loadSkill(skillPath);

      // Empty arrays don't match the regex pattern, so they become undefined
      expect(skill.allowedTools).toBeUndefined();
    });
  });
});
