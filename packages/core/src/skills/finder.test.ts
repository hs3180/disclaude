/**
 * Tests for SkillFinder module.
 *
 * Validates skill discovery, content reading, and skill file structure.
 * Uses custom search paths to avoid dependency on Config module.
 *
 * @module skills/finder.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  findSkill,
  listSkills,
  skillExists,
  readSkillContent,
  type SkillSearchPath,
} from './finder.js';

describe('SkillFinder', () => {
  let tempDir: string;
  let searchPaths: SkillSearchPath[];

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-finder-test-'));

    // Create test skill structure
    const skillsDir = path.join(tempDir, 'skills');

    // Create agentic-research-interactive skill
    const interactiveDir = path.join(skillsDir, 'agentic-research-interactive');
    await fs.mkdir(interactiveDir, { recursive: true });
    await fs.writeFile(
      path.join(interactiveDir, 'SKILL.md'),
      `---
name: agentic-research-interactive
description: Interactive Agentic Research workflow
---

# Interactive Agentic Research

## Phase 1: Outline Generation
Content for phase 1

## Phase 2: Research Execution
Content for phase 2

## Phase 3: Report Delivery
Content for phase 3
`,
      'utf-8'
    );

    // Create another test skill
    const evaluatorDir = path.join(skillsDir, 'evaluator');
    await fs.mkdir(evaluatorDir, { recursive: true });
    await fs.writeFile(
      path.join(evaluatorDir, 'SKILL.md'),
      `---
name: evaluator
description: Task completion evaluation specialist
---

# Evaluator Agent

Content here
`,
      'utf-8'
    );

    // Create a directory without SKILL.md (should be ignored)
    const emptyDir = path.join(skillsDir, 'empty-skill');
    await fs.mkdir(emptyDir, { recursive: true });

    searchPaths = [
      { path: skillsDir, domain: 'package', priority: 1 },
    ];
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('findSkill', () => {
    it('should find an existing skill by name', async () => {
      const skillPath = await findSkill('agentic-research-interactive', searchPaths);
      expect(skillPath).not.toBeNull();
      expect(skillPath).toContain('agentic-research-interactive');
      expect(skillPath).toContain('SKILL.md');
    });

    it('should return null for non-existent skill', async () => {
      const skillPath = await findSkill('non-existent-skill', searchPaths);
      expect(skillPath).toBeNull();
    });

    it('should find evaluator skill', async () => {
      const skillPath = await findSkill('evaluator', searchPaths);
      expect(skillPath).not.toBeNull();
      expect(skillPath).toContain('evaluator');
    });
  });

  describe('listSkills', () => {
    it('should list all skills with SKILL.md files', async () => {
      const skills = await listSkills(searchPaths);
      const names = skills.map(s => s.name);

      expect(names).toContain('agentic-research-interactive');
      expect(names).toContain('evaluator');
      // Empty skill without SKILL.md should not be listed
      expect(names).not.toContain('empty-skill');
    });

    it('should return correct domain for each skill', async () => {
      const skills = await listSkills(searchPaths);
      for (const skill of skills) {
        expect(skill.domain).toBe('package');
      }
    });

    it('should return paths ending with SKILL.md', async () => {
      const skills = await listSkills(searchPaths);
      for (const skill of skills) {
        expect(skill.path).toMatch(/SKILL\.md$/);
      }
    });
  });

  describe('skillExists', () => {
    it('should return true for existing skill', async () => {
      const exists = await skillExists('agentic-research-interactive', searchPaths);
      expect(exists).toBe(true);
    });

    it('should return false for non-existent skill', async () => {
      const exists = await skillExists('does-not-exist', searchPaths);
      expect(exists).toBe(false);
    });
  });

  describe('readSkillContent', () => {
    it('should read skill content correctly', async () => {
      const content = await readSkillContent('agentic-research-interactive', searchPaths);
      expect(content).not.toBeNull();
      expect(content).toContain('Interactive Agentic Research');
      expect(content).toContain('Phase 1: Outline Generation');
      expect(content).toContain('Phase 2: Research Execution');
      expect(content).toContain('Phase 3: Report Delivery');
    });

    it('should include frontmatter in content', async () => {
      const content = await readSkillContent('agentic-research-interactive', searchPaths);
      expect(content).not.toBeNull();
      expect(content).toContain('name: agentic-research-interactive');
      expect(content).toContain('description: Interactive Agentic Research workflow');
    });

    it('should return null for non-existent skill', async () => {
      const content = await readSkillContent('non-existent', searchPaths);
      expect(content).toBeNull();
    });
  });

  describe('priority ordering', () => {
    it('should prefer higher priority path when skill exists in multiple domains', async () => {
      // Create same skill in project domain (higher priority)
      const projectDir = path.join(tempDir, 'project', '.claude', 'skills', 'evaluator');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'SKILL.md'),
        '# Project Evaluator\nCustom version',
        'utf-8'
      );

      const multiSearchPaths: SkillSearchPath[] = [
        { path: path.join(tempDir, 'project', '.claude', 'skills'), domain: 'project', priority: 3 },
        { path: path.join(tempDir, 'skills'), domain: 'package', priority: 1 },
      ];

      const skillPath = await findSkill('evaluator', multiSearchPaths);
      expect(skillPath).toContain('project');
      expect(skillPath).not.toContain(path.join(tempDir, 'skills'));

      const content = await readSkillContent('evaluator', multiSearchPaths);
      expect(content).toContain('Custom version');
    });
  });
});
