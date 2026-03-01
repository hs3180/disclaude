/**
 * Tests for SkillLoader - Generic skill loading for Agent SDK.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SkillLoader } from './skill-loader.js';

describe('SkillLoader', () => {
  let tempDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-loader-test-'));
    loader = new SkillLoader();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('loadSkill', () => {
    it('should load a skill from an absolute path', async () => {
      const skillPath = path.join(tempDir, 'test-skill.md');
      await fs.writeFile(skillPath, '# Test Skill\n\nThis is a test skill.');

      const skill = await loader.loadSkill(skillPath);

      expect(skill.name).toBe('Test Skill');
      expect(skill.description).toBe('This is a test skill.');
      expect(skill.content).toContain('# Test Skill');
      expect(skill.filePath).toBe(skillPath);
    });

    it('should extract skill name from first heading', async () => {
      const skillPath = path.join(tempDir, 'skill.md');
      await fs.writeFile(skillPath, '# My Awesome Skill\n\nDescription here.');

      const skill = await loader.loadSkill(skillPath);

      expect(skill.name).toBe('My Awesome Skill');
    });

    it('should handle "Skill:" prefix in heading', async () => {
      const skillPath = path.join(tempDir, 'skill.md');
      await fs.writeFile(skillPath, '# Skill: Evaluator\n\nDescription.');

      const skill = await loader.loadSkill(skillPath);

      expect(skill.name).toBe('Evaluator');
    });

    it('should extract description from first paragraph', async () => {
      const skillPath = path.join(tempDir, 'skill.md');
      await fs.writeFile(skillPath, '# Skill\n\nThis is the description.\n\n## Next Section\nMore content.');

      const skill = await loader.loadSkill(skillPath);

      expect(skill.description).toBe('This is the description.');
    });

    it('should truncate long descriptions', async () => {
      const skillPath = path.join(tempDir, 'skill.md');
      const longDesc = 'A'.repeat(300);
      await fs.writeFile(skillPath, `# Skill\n\n${longDesc}`);

      const skill = await loader.loadSkill(skillPath);

      expect(skill.description.length).toBeLessThanOrEqual(200);
      expect(skill.description).toMatch(/\.\.\.$/);
    });

    it('should handle skill with frontmatter', async () => {
      const skillPath = path.join(tempDir, 'skill.md');
      await fs.writeFile(skillPath, `---
allowed-tools:
  - Read
  - Write
---
# Skill With Frontmatter

Description here.`);

      const skill = await loader.loadSkill(skillPath);

      expect(skill.name).toBe('Skill With Frontmatter');
      expect(skill.allowedTools).toBeDefined();
      expect(skill.allowedTools).toContain('Read');
      expect(skill.allowedTools).toContain('Write');
    });

    it('should extract allowed tools from Tools Available section', async () => {
      const skillPath = path.join(tempDir, 'skill.md');
      await fs.writeFile(skillPath, `# Skill

Description.

## Tools Available

- \`Read\`
- \`Write\`
- \`Grep\`

## Other Section`);

      const skill = await loader.loadSkill(skillPath);

      expect(skill.allowedTools).toBeDefined();
      expect(skill.allowedTools).toContain('Read');
      expect(skill.allowedTools).toContain('Write');
      expect(skill.allowedTools).toContain('Grep');
    });

    it('should handle skill without heading', async () => {
      const skillPath = path.join(tempDir, 'no-heading-skill.md');
      await fs.writeFile(skillPath, 'Just some content without a heading.');

      const skill = await loader.loadSkill(skillPath);

      expect(skill.name).toBe('no-heading-skill');
    });

    it('should throw on non-existent file', async () => {
      await expect(loader.loadSkill('/non/existent/skill.md')).rejects.toThrow();
    });
  });

  describe('loadSkillsFromDirectory', () => {
    it('should load all skills from a directory', async () => {
      // Create skill directories
      await fs.mkdir(path.join(tempDir, 'skill1'));
      await fs.mkdir(path.join(tempDir, 'skill2'));

      await fs.writeFile(
        path.join(tempDir, 'skill1', 'SKILL.md'),
        '# Skill One\n\nFirst skill.'
      );
      await fs.writeFile(
        path.join(tempDir, 'skill2', 'SKILL.md'),
        '# Skill Two\n\nSecond skill.'
      );

      const skills = await loader.loadSkillsFromDirectory(tempDir);

      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name)).toContain('skill1');
      expect(skills.map(s => s.name)).toContain('skill2');
    });

    it('should skip directories without skill files', async () => {
      await fs.mkdir(path.join(tempDir, 'with-skill'));
      await fs.mkdir(path.join(tempDir, 'without-skill'));

      await fs.writeFile(
        path.join(tempDir, 'with-skill', 'SKILL.md'),
        '# Has Skill\n\nContent.'
      );
      // Don't create SKILL.md in without-skill

      const skills = await loader.loadSkillsFromDirectory(tempDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('with-skill');
    });

    it('should return empty array for non-existent directory', async () => {
      const skills = await loader.loadSkillsFromDirectory('/non/existent/directory');

      expect(skills).toEqual([]);
    });

    it('should skip non-directory entries', async () => {
      await fs.mkdir(path.join(tempDir, 'real-skill'));
      await fs.writeFile(path.join(tempDir, 'file.md'), '# Not a directory');

      await fs.writeFile(
        path.join(tempDir, 'real-skill', 'SKILL.md'),
        '# Real Skill\n\nContent.'
      );

      const skills = await loader.loadSkillsFromDirectory(tempDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('real-skill');
    });
  });

  describe('searchSkills', () => {
    it('should search across multiple directories', async () => {
      const dir1 = path.join(tempDir, 'dir1');
      const dir2 = path.join(tempDir, 'dir2');

      await fs.mkdir(path.join(dir1, 'skill1'), { recursive: true });
      await fs.mkdir(path.join(dir2, 'skill2'), { recursive: true });

      await fs.writeFile(
        path.join(dir1, 'skill1', 'SKILL.md'),
        '# Skill One\n\nFrom dir1.'
      );
      await fs.writeFile(
        path.join(dir2, 'skill2', 'SKILL.md'),
        '# Skill Two\n\nFrom dir2.'
      );

      const skills = await loader.searchSkills([dir1, dir2]);

      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name)).toContain('skill1');
      expect(skills.map(s => s.name)).toContain('skill2');
    });

    it('should deduplicate skills by name', async () => {
      const dir1 = path.join(tempDir, 'dir1');
      const dir2 = path.join(tempDir, 'dir2');

      await fs.mkdir(path.join(dir1, 'common-skill'), { recursive: true });
      await fs.mkdir(path.join(dir2, 'common-skill'), { recursive: true });

      await fs.writeFile(
        path.join(dir1, 'common-skill', 'SKILL.md'),
        '# Common Skill\n\nFrom dir1.'
      );
      await fs.writeFile(
        path.join(dir2, 'common-skill', 'SKILL.md'),
        '# Common Skill\n\nFrom dir2 (override).'
      );

      const skills = await loader.searchSkills([dir1, dir2]);

      expect(skills).toHaveLength(1);
      // dir2 (later in array) should override dir1
      expect(skills[0].content).toContain('override');
    });

    it('should handle non-existent directories gracefully', async () => {
      const dir1 = path.join(tempDir, 'exists');
      const dir2 = '/non/existent';

      await fs.mkdir(path.join(dir1, 'skill1'), { recursive: true });
      await fs.writeFile(
        path.join(dir1, 'skill1', 'SKILL.md'),
        '# Skill One\n\nContent.'
      );

      const skills = await loader.searchSkills([dir1, dir2]);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('skill1');
    });
  });

  describe('findSkill', () => {
    it('should find a skill by name', async () => {
      await fs.mkdir(path.join(tempDir, 'target-skill'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, 'target-skill', 'SKILL.md'),
        '# Target Skill\n\nFound it.'
      );

      const skill = await loader.findSkill('target-skill', [tempDir]);

      expect(skill).toBeDefined();
      expect(skill?.name).toBe('target-skill');
    });

    it('should return undefined if skill not found', async () => {
      const skill = await loader.findSkill('non-existent', [tempDir]);

      expect(skill).toBeUndefined();
    });

    it('should find skill in first matching path', async () => {
      const dir1 = path.join(tempDir, 'dir1');
      const dir2 = path.join(tempDir, 'dir2');

      await fs.mkdir(path.join(dir1, 'my-skill'), { recursive: true });
      await fs.mkdir(path.join(dir2, 'my-skill'), { recursive: true });

      await fs.writeFile(
        path.join(dir1, 'my-skill', 'SKILL.md'),
        '# My Skill\n\nFrom dir1.'
      );
      await fs.writeFile(
        path.join(dir2, 'my-skill', 'SKILL.md'),
        '# My Skill\n\nFrom dir2.'
      );

      const skill = await loader.findSkill('my-skill', [dir1, dir2]);

      expect(skill).toBeDefined();
      expect(skill?.content).toContain('From dir1');
    });
  });

  describe('getDefaultSearchPaths', () => {
    it('should return default search paths', () => {
      const testLoader = new SkillLoader();
      const paths = testLoader.getDefaultSearchPaths();

      expect(paths.length).toBeGreaterThan(0);
      // Should include package skills directory
      expect(paths.some(p => p.includes('skills'))).toBe(true);
    });

    it('should include additional search paths', () => {
      const testLoader = new SkillLoader({
        searchPaths: ['/custom/path1', '/custom/path2'],
      });

      const paths = testLoader.getDefaultSearchPaths();

      expect(paths[0]).toBe('/custom/path1');
      expect(paths[1]).toBe('/custom/path2');
    });
  });

  describe('custom skill file name', () => {
    it('should use custom skill file name', async () => {
      const customLoader = new SkillLoader({
        skillFileName: 'PROMPT.md',
      });

      await fs.mkdir(path.join(tempDir, 'my-skill'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, 'my-skill', 'PROMPT.md'),
        '# Custom Skill\n\nUses PROMPT.md'
      );

      const skills = await customLoader.loadSkillsFromDirectory(tempDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('my-skill');
      expect(skills[0].content).toContain('PROMPT.md');
    });
  });

  describe('Skill interface', () => {
    it('should return complete Skill object', async () => {
      const skillPath = path.join(tempDir, 'complete-skill.md');
      await fs.writeFile(skillPath, `---
allowed-tools:
  - Read
  - Write
---
# Complete Skill

This is a complete skill with all fields.

## Tools Available

- Read
- Write
`);

      const skill = await loader.loadSkill(skillPath);

      expect(skill.name).toBe('Complete Skill');
      expect(skill.description).toBe('This is a complete skill with all fields.');
      expect(skill.allowedTools).toBeDefined();
      expect(skill.allowedTools).toHaveLength(2);
      expect(skill.content).toContain('Complete Skill');
      expect(skill.filePath).toBe(skillPath);
    });
  });
});
