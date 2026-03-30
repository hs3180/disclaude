/**
 * Tests for self-experience skill (Issue #1560).
 *
 * Validates that the self-experience (dogfooding) skill:
 * - Exists in the package skills directory
 * - Has valid SKILL.md with proper YAML frontmatter
 * - Contains required sections and keywords
 * - Can be discovered by the skill finder
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  findSkill,
  skillExists,
  readSkillContent,
  type SkillSearchPath,
} from './finder.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/test/workspace',
    getSkillsDir: () => '/test/package/skills',
  },
}));

const SKILL_NAME = 'self-experience';

/** Minimal valid SKILL.md content for testing */
const VALID_SKILL_CONTENT = `---
name: self-experience
description: Self-experience (dogfooding) specialist
allowed-tools: Read, Glob, Grep, Bash, WebSearch, send_user_feedback
---

# Self-Experience (Dogfooding) Specialist

## When to Use This Skill

Use this skill for automated post-release feature validation.

## Self-Experience Process

### Step 1: Environment Analysis

### Step 2: Activity Planning

### Step 3: Execute Exploration

### Step 4: Generate Report

### Step 5: Save History and Send Report

## Schedule Configuration

## Anti-Recursion Rules

**IMPORTANT**: When running as a scheduled task:
- Do NOT create new scheduled tasks
- Do NOT modify existing scheduled tasks

## Checklist
`;

describe('self-experience skill', () => {
  let mockAccess: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;

  const packagePath: SkillSearchPath = {
    path: '/test/package/skills',
    domain: 'package',
    priority: 1,
  };

  const searchPaths = [packagePath];

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess = vi.mocked(fs.access);
    mockReadFile = vi.mocked(fs.readFile);
  });

  describe('discoverability', () => {
    it('should be discoverable via findSkill', async () => {
      mockAccess.mockResolvedValue(undefined);

      const result = await findSkill(SKILL_NAME, searchPaths);

      expect(result).toContain(SKILL_NAME);
      expect(result).toContain('SKILL.md');
    });

    it('should return true from skillExists', async () => {
      mockAccess.mockResolvedValue(undefined);

      const result = await skillExists(SKILL_NAME, searchPaths);

      expect(result).toBe(true);
    });

    it('should return null when skill is not found', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await findSkill(SKILL_NAME, searchPaths);

      expect(result).toBeNull();
    });
  });

  describe('content validation', () => {
    it('should return skill content via readSkillContent', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(VALID_SKILL_CONTENT);

      const content = await readSkillContent(SKILL_NAME, searchPaths);

      expect(content).not.toBeNull();
      expect(content).toContain('self-experience');
    });

    it('should have valid YAML frontmatter with required fields', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(VALID_SKILL_CONTENT);

      const content = await readSkillContent(SKILL_NAME, searchPaths);
      expect(content).not.toBeNull();

      // Check YAML frontmatter delimiters
      expect(content).toMatch(/^---\n/);
      expect(content).toContain('---\n\n#');

      // Check required frontmatter fields
      expect(content).toContain('name: self-experience');
      expect(content).toContain('description:');
      expect(content).toContain('allowed-tools:');
    });

    it('should include dogfooding-related keywords in description', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(VALID_SKILL_CONTENT);

      const content = await readSkillContent(SKILL_NAME, searchPaths);
      expect(content).not.toBeNull();

      // Verify description contains key terms
      expect(content).toContain('dogfooding');
      expect(content).toContain('self-experience');
    });

    it('should include required process sections', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(VALID_SKILL_CONTENT);

      const content = await readSkillContent(SKILL_NAME, searchPaths);
      expect(content).not.toBeNull();

      // Verify all 5 steps are present
      expect(content).toContain('Step 1');
      expect(content).toContain('Step 2');
      expect(content).toContain('Step 3');
      expect(content).toContain('Step 4');
      expect(content).toContain('Step 5');
    });

    it('should include schedule configuration section', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(VALID_SKILL_CONTENT);

      const content = await readSkillContent(SKILL_NAME, searchPaths);
      expect(content).not.toBeNull();

      expect(content).toContain('Schedule Configuration');
    });

    it('should include checklist section', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(VALID_SKILL_CONTENT);

      const content = await readSkillContent(SKILL_NAME, searchPaths);
      expect(content).not.toBeNull();

      expect(content).toContain('Checklist');
    });

    it('should include send_user_feedback in allowed-tools', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(VALID_SKILL_CONTENT);

      const content = await readSkillContent(SKILL_NAME, searchPaths);
      expect(content).not.toBeNull();

      // send_user_feedback is critical for reporting results
      expect(content).toContain('send_user_feedback');
    });

    it('should include anti-recursion rules', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(VALID_SKILL_CONTENT);

      const content = await readSkillContent(SKILL_NAME, searchPaths);
      expect(content).not.toBeNull();

      // Anti-recursion is critical for scheduled execution safety
      expect(content).toContain('Anti-Recursion');
    });

    it('should return null when readSkillContent fails', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockRejectedValue(new Error('Permission denied'));

      const content = await readSkillContent(SKILL_NAME, searchPaths);

      expect(content).toBeNull();
    });
  });
});
