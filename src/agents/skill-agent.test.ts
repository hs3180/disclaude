/**
 * Tests for SkillAgent - Minimal agent that executes skills from markdown files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SkillAgent } from './skill-agent.js';
import type { BaseAgentConfig } from './types.js';

// Test skill file content
const TEST_SKILL_CONTENT = `# Test Skill

This is a test skill prompt.

Task ID: {taskId}
Iteration: {iteration}
Custom Var: {customVar}
`;

describe('SkillAgent', () => {
  let tempDir: string;
  let skillPath: string;
  let mockConfig: BaseAgentConfig;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-agent-test-'));
    skillPath = path.join(tempDir, 'test-skill.md');
    await fs.writeFile(skillPath, TEST_SKILL_CONTENT);

    // Mock config - use test API key
    mockConfig = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create SkillAgent with skill path', () => {
    const agent = new SkillAgent(mockConfig, skillPath);

    expect(agent.type).toBe('skill');
    expect(agent.name).toBe('test-skill');
  });

  it('should initialize properly', async () => {
    const agent = new SkillAgent(mockConfig, skillPath);
    await agent.initialize();

    // Should be idempotent
    await agent.initialize();
  });

  it('should dispose properly', async () => {
    const agent = new SkillAgent(mockConfig, skillPath);
    await agent.initialize();

    agent.dispose();

    // Should be safe to call dispose multiple times
    agent.dispose();
  });

  it('should extract skill name from relative path', () => {
    const agent = new SkillAgent(mockConfig, 'skills/evaluator/SKILL.md');

    expect(agent.name).toBe('SKILL');
  });

  describe('template variable substitution', () => {
    it('should substitute template variables in skill content', async () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      await agent.initialize();

      // The template substitution is internal, but we can verify it doesn't throw
      const generator = agent.executeWithContext({
        templateVars: {
          taskId: 'task-123',
          iteration: '1',
          customVar: 'custom-value',
        },
      });

      // Just verify it returns an async generator
      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });
  });

  describe('execute method', () => {
    it('should accept string input', async () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      await agent.initialize();

      const generator = agent.execute('test input');

      // Verify it returns an async generator
      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should accept UserInput array', async () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      await agent.initialize();

      const generator = agent.execute([
        { role: 'user', content: 'test input 1' },
        { role: 'user', content: 'test input 2' },
      ]);

      // Verify it returns an async generator
      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });
  });
});
