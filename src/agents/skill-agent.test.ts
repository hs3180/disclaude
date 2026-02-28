/**
 * Tests for SkillAgent - Generic agent that executes skills from markdown files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SkillAgent, SkillAgentFactory, parseSkillFile } from './skill-agent.js';
import type { BaseAgentConfig } from './types.js';

// Test skill file content
const TEST_SKILL_CONTENT = `---
name: test-skill
description: A test skill for unit testing
allowedTools:
  - Read
  - Write
---

# Test Skill

This is a test skill prompt.

Task ID: {taskId}
Iteration: {iteration}
`;

const INVALID_SKILL_CONTENT = `# Missing Frontmatter

This skill has no YAML frontmatter.
`;

describe('parseSkillFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should parse valid skill file', async () => {
    const skillPath = path.join(tempDir, 'test-skill.md');
    await fs.writeFile(skillPath, TEST_SKILL_CONTENT);

    const config = await parseSkillFile(skillPath);

    expect(config.name).toBe('test-skill');
    expect(config.description).toBe('A test skill for unit testing');
    expect(config.allowedTools).toEqual(['Read', 'Write']);
    expect(config.prompt).toContain('# Test Skill');
    expect(config.prompt).toContain('{taskId}');
  });

  it('should throw error for missing frontmatter', async () => {
    const skillPath = path.join(tempDir, 'invalid-skill.md');
    await fs.writeFile(skillPath, INVALID_SKILL_CONTENT);

    await expect(parseSkillFile(skillPath)).rejects.toThrow('Invalid skill file format');
  });

  it('should throw error for missing name field', async () => {
    const skillPath = path.join(tempDir, 'no-name-skill.md');
    const content = `---
description: No name skill
allowedTools:
  - Read
---

# No Name
`;
    await fs.writeFile(skillPath, content);

    await expect(parseSkillFile(skillPath)).rejects.toThrow("missing 'name' field");
  });
});

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

  it('should initialize and load skill config', async () => {
    const agent = new SkillAgent(mockConfig, skillPath);
    await agent.initialize();

    const config = agent.getSkillConfig();

    expect(config.name).toBe('test-skill');
    expect(config.allowedTools).toEqual(['Read', 'Write']);
  });

  it('should throw error when getting config before initialization', () => {
    const agent = new SkillAgent(mockConfig, skillPath);

    expect(() => agent.getSkillConfig()).toThrow('Skill not initialized');
  });

  it('should be idempotent on multiple initializations', async () => {
    const agent = new SkillAgent(mockConfig, skillPath);

    await agent.initialize();
    await agent.initialize(); // Should not throw

    const config = agent.getSkillConfig();
    expect(config.name).toBe('test-skill');
  });

  it('should dispose properly', async () => {
    const agent = new SkillAgent(mockConfig, skillPath);
    await agent.initialize();

    agent.dispose();

    // Should be safe to call dispose multiple times
    agent.dispose();
  });
});

describe('SkillAgentFactory', () => {
  let tempDir: string;
  let mockConfig: BaseAgentConfig;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-factory-test-'));

    // Create skill files
    await fs.writeFile(path.join(tempDir, 'evaluate.md'), TEST_SKILL_CONTENT);
    await fs.writeFile(path.join(tempDir, 'execute.md'), TEST_SKILL_CONTENT);
    await fs.writeFile(path.join(tempDir, 'report.md'), TEST_SKILL_CONTENT);

    mockConfig = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create evaluator skill agent', () => {
    const factory = new SkillAgentFactory(mockConfig, tempDir);
    const agent = factory.createEvaluator();

    expect(agent).toBeInstanceOf(SkillAgent);
    expect(agent.name).toBe('evaluate');
  });

  it('should create executor skill agent', () => {
    const factory = new SkillAgentFactory(mockConfig, tempDir);
    const agent = factory.createExecutor();

    expect(agent).toBeInstanceOf(SkillAgent);
    expect(agent.name).toBe('execute');
  });

  it('should create reporter skill agent', () => {
    const factory = new SkillAgentFactory(mockConfig, tempDir);
    const agent = factory.createReporter();

    expect(agent).toBeInstanceOf(SkillAgent);
    expect(agent.name).toBe('report');
  });

  it('should create skill agent by name', () => {
    const factory = new SkillAgentFactory(mockConfig, tempDir);
    const agent = factory.create('evaluate');

    expect(agent).toBeInstanceOf(SkillAgent);
    expect(agent.name).toBe('evaluate');
  });
});
