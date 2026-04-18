/**
 * Tests for the task-eta skill.
 *
 * Validates:
 * - SKILL.md file exists and has valid frontmatter
 * - Skill name and description are correctly set
 * - Required sections are present in the skill content
 * - Template formats are valid Markdown
 *
 * @module skills/task-eta/__tests__
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SKILL_PATH = path.join(__dirname, '..', 'SKILL.md');

describe('task-eta skill', () => {
  let skillContent: string;

  beforeAll(() => {
    skillContent = fs.readFileSync(SKILL_PATH, 'utf-8');
  });

  describe('file structure', () => {
    it('should have SKILL.md file', () => {
      expect(fs.existsSync(SKILL_PATH)).toBe(true);
    });

    it('should be non-empty', () => {
      expect(skillContent.length).toBeGreaterThan(100);
    });
  });

  describe('frontmatter', () => {
    it('should have valid YAML frontmatter', () => {
      const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).not.toBeNull();
      expect(frontmatterMatch![1]).toBeTruthy();
    });

    it('should have name: task-eta', () => {
      const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = frontmatterMatch![1];
      expect(frontmatter).toContain('name: task-eta');
    });

    it('should have description', () => {
      const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = frontmatterMatch![1];
      expect(frontmatter).toContain('description:');
      // Description should mention ETA and task estimation
      expect(frontmatter.toLowerCase()).toContain('eta');
      expect(frontmatter.toLowerCase()).toContain('task');
    });

    it('should have allowed-tools', () => {
      const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = frontmatterMatch![1];
      expect(frontmatter).toContain('allowed-tools:');
      // Should have Read, Write, Edit for file operations
      expect(frontmatter).toContain('Read');
      expect(frontmatter).toContain('Write');
      expect(frontmatter).toContain('Edit');
    });
  });

  describe('content sections', () => {
    it('should describe when to use the skill', () => {
      expect(skillContent).toContain('When to Use');
    });

    it('should define storage location', () => {
      expect(skillContent).toContain('task-records.md');
      expect(skillContent).toContain('eta-rules.md');
    });

    it('should include estimate action', () => {
      expect(skillContent).toContain('Estimate Task ETA');
    });

    it('should include record action', () => {
      expect(skillContent).toContain('Record Completed Task');
    });

    it('should include update rules action', () => {
      expect(skillContent).toContain('Update Rules');
    });

    it('should include initialization action', () => {
      expect(skillContent).toContain('Initialize Files');
    });

    it('should define task record format', () => {
      // Task record format should include key fields
      expect(skillContent).toContain('**Type**:');
      expect(skillContent).toContain('**Estimated**:');
      expect(skillContent).toContain('**Actual**:');
      expect(skillContent).toContain('**Accuracy**:');
    });

    it('should define ETA estimate output format', () => {
      expect(skillContent).toContain('Estimated Time');
      expect(skillContent).toContain('Confidence');
      expect(skillContent).toContain('Reasoning');
    });

    it('should include integration guidance', () => {
      expect(skillContent).toContain('deep-task');
      expect(skillContent).toContain('evaluator');
    });

    it('should emphasize non-structured Markdown storage', () => {
      expect(skillContent).toContain('Non-structured Markdown');
      expect(skillContent).toContain('Markdown');
    });

    it('should have DO NOT section', () => {
      expect(skillContent).toContain('DO NOT');
    });
  });

  describe('template content validation', () => {
    it('should have valid task-records.md template', () => {
      const templateMatch = skillContent.match(/```markdown\n# Task Records[\s\S]*?```/);
      expect(templateMatch).not.toBeNull();
    });

    it('should have valid eta-rules.md template', () => {
      const templateMatch = skillContent.match(/```markdown\n# ETA Estimation Rules[\s\S]*?```/);
      expect(templateMatch).not.toBeNull();
    });

    it('should define task type baselines in rules template', () => {
      // Should have at least some task type baselines
      expect(skillContent).toContain('bugfix');
      expect(skillContent).toContain('feature');
      expect(skillContent).toContain('refactoring');
    });

    it('should include experience rules patterns', () => {
      expect(skillContent).toContain('Overestimation');
      expect(skillContent).toContain('Underestimation');
    });
  });
});
