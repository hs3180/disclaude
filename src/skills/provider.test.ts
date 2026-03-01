/**
 * Tests for ClaudeCodeSkillProvider.
 *
 * Tests Phase 2-4 of Issue #430:
 * - Phase 2: Claude Code Agent Skills implementation
 * - Phase 3: Skills injection mechanism
 * - Phase 4: Project domain support
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ClaudeCodeSkillProvider } from './provider.js';
import { FileSystemSkillLoader } from './loader.js';

describe('ClaudeCodeSkillProvider', () => {
  let tempDir: string;
  let provider: ClaudeCodeSkillProvider;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-provider-test-'));
    provider = new ClaudeCodeSkillProvider({
      context: {
        workspaceDir: tempDir,
        packageDir: tempDir,
      },
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getDefaultSearchPaths', () => {
    it('should return paths in correct priority order', () => {
      const paths = provider.getDefaultSearchPaths();

      expect(paths).toHaveLength(3);

      // Check priority order (highest first)
      expect(paths[0].domain).toBe('project');
      expect(paths[0].priority).toBe(3);

      expect(paths[1].domain).toBe('workspace');
      expect(paths[1].priority).toBe(2);

      expect(paths[2].domain).toBe('package');
      expect(paths[2].priority).toBe(1);
    });

    it('should include additional paths when provided', () => {
      const providerWithExtra = new ClaudeCodeSkillProvider({
        context: {
          workspaceDir: tempDir,
          packageDir: tempDir,
          additionalPaths: [
            { path: '/custom/skills', domain: 'custom', priority: 4 },
          ],
        },
      });

      const paths = providerWithExtra.getDefaultSearchPaths();

      expect(paths).toHaveLength(4);
      expect(paths.some(p => p.domain === 'custom')).toBe(true);
    });
  });

  describe('loadSkillsForAgent', () => {
    it('should load skill for specific agent', async () => {
      // Create package skills directory
      const skillsDir = path.join(tempDir, 'skills', 'evaluator');
      await fs.mkdir(skillsDir, { recursive: true });

      const skillContent = `---
name: evaluator
description: Test evaluator
allowed-tools: [Read, Write]
---

# Evaluator Skill

Test content for evaluator.
`;

      await fs.writeFile(path.join(skillsDir, 'SKILL.md'), skillContent);

      const result = await provider.loadSkillsForAgent('evaluator');

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('evaluator');
      expect(result.allowedTools).toEqual(['Read', 'Write']);
      expect(result.systemPromptContent).toContain('Evaluator Skill');
      expect(result.systemPromptContent).toContain('Test content for evaluator');
    });

    it('should prefer higher priority paths', async () => {
      // Create skill in package domain
      const packageDir = path.join(tempDir, 'skills', 'test-skill');
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(
        path.join(packageDir, 'SKILL.md'),
        `---
name: test-skill
allowed-tools: [Read]
---
# Package Skill
`
      );

      // Create skill in project domain (higher priority)
      const projectDir = path.join(tempDir, '.claude', 'skills', 'test-skill');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'SKILL.md'),
        `---
name: test-skill
allowed-tools: [Read, Write, Bash]
---
# Project Skill (Override)
`
      );

      const result = await provider.loadSkillsForAgent('test-skill');

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].allowedTools).toEqual(['Read', 'Write', 'Bash']);
      expect(result.systemPromptContent).toContain('Project Skill (Override)');
    });

    it('should return empty result when skill not found', async () => {
      const result = await provider.loadSkillsForAgent('nonexistent');

      expect(result.skills).toHaveLength(0);
      expect(result.allowedTools).toHaveLength(0);
      expect(result.systemPromptContent).toBe('');
    });

    it('should cache loaded skills', async () => {
      // Create skill
      const skillsDir = path.join(tempDir, 'skills', 'cached-skill');
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.writeFile(
        path.join(skillsDir, 'SKILL.md'),
        `---
name: cached-skill
---
# Cached
`
      );

      // First load
      const result1 = await provider.loadSkillsForAgent('cached-skill');
      expect(result1.skills).toHaveLength(1);

      // Delete the skill file
      await fs.rm(skillsDir, { recursive: true, force: true });

      // Second load should return cached result
      const result2 = await provider.loadSkillsForAgent('cached-skill');
      expect(result2.skills).toHaveLength(1);
    });

    it('should clear cache when requested', async () => {
      // Create skill
      const skillsDir = path.join(tempDir, 'skills', 'clear-cache-skill');
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.writeFile(
        path.join(skillsDir, 'SKILL.md'),
        `---
name: clear-cache-skill
---
# Original
`
      );

      // Load and cache
      await provider.loadSkillsForAgent('clear-cache-skill');

      // Clear cache
      provider.clearCache();

      // Modify skill
      await fs.writeFile(
        path.join(skillsDir, 'SKILL.md'),
        `---
name: clear-cache-skill
---
# Modified
`
      );

      // Should load new content
      const result = await provider.loadSkillsForAgent('clear-cache-skill');
      expect(result.systemPromptContent).toContain('Modified');
    });
  });

  describe('loadAllSkills', () => {
    it('should load all skills from all paths', async () => {
      // Create multiple skills
      const evaluatorDir = path.join(tempDir, 'skills', 'evaluator');
      await fs.mkdir(evaluatorDir, { recursive: true });
      await fs.writeFile(
        path.join(evaluatorDir, 'SKILL.md'),
        `---
name: evaluator
allowed-tools: [Read, Write]
---
# Evaluator
`
      );

      const executorDir = path.join(tempDir, 'skills', 'executor');
      await fs.mkdir(executorDir, { recursive: true });
      await fs.writeFile(
        path.join(executorDir, 'SKILL.md'),
        `---
name: executor
allowed-tools: [Read, Write, Bash]
---
# Executor
`
      );

      const result = await provider.loadAllSkills();

      expect(result.skills.length).toBeGreaterThanOrEqual(2);
      expect(result.allowedTools).toContain('Read');
      expect(result.allowedTools).toContain('Write');
      expect(result.allowedTools).toContain('Bash');
    });
  });

  describe('systemPromptContent', () => {
    it('should extract content without frontmatter', async () => {
      const skillsDir = path.join(tempDir, 'skills', 'prompt-skill');
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.writeFile(
        path.join(skillsDir, 'SKILL.md'),
        `---
name: prompt-skill
description: Test description
---

# Main Content

This is the actual skill content.

## Section 1
Details here.
`
      );

      const result = await provider.loadSkillsForAgent('prompt-skill');

      // Should not contain frontmatter
      expect(result.systemPromptContent).not.toContain('---');
      expect(result.systemPromptContent).not.toContain('description:');

      // Should contain actual content
      expect(result.systemPromptContent).toContain('Main Content');
      expect(result.systemPromptContent).toContain('Section 1');
    });

    it('should format multiple skills with headers', async () => {
      // Create provider with skills
      const providerWithLoader = new ClaudeCodeSkillProvider({
        loader: new FileSystemSkillLoader(),
        context: {
          workspaceDir: tempDir,
          packageDir: tempDir,
        },
      });

      // Create two skills
      const skill1Dir = path.join(tempDir, 'skills', 'skill1');
      await fs.mkdir(skill1Dir, { recursive: true });
      await fs.writeFile(
        path.join(skill1Dir, 'SKILL.md'),
        `---
name: skill1
---
# Skill 1 Content
`
      );

      const skill2Dir = path.join(tempDir, 'skills', 'skill2');
      await fs.mkdir(skill2Dir, { recursive: true });
      await fs.writeFile(
        path.join(skill2Dir, 'SKILL.md'),
        `---
name: skill2
---
# Skill 2 Content
`
      );

      const result = await providerWithLoader.loadAllSkills();

      if (result.skills.length >= 2) {
        expect(result.systemPromptContent).toContain('# Skills');
        expect(result.systemPromptContent).toContain('## Skill: skill1');
        expect(result.systemPromptContent).toContain('## Skill: skill2');
      }
    });

    it('should return empty string when no skills loaded', async () => {
      const result = await provider.loadAllSkills();

      expect(result.systemPromptContent).toBe('');
    });
  });
});
