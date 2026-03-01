/**
 * Tests for SkillAgent - Minimal agent that executes skills from markdown files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// Skill content with multiple template variables
const COMPLEX_SKILL_CONTENT = `# Complex Skill

## Context
- Task ID: {taskId}
- Iteration: {iteration}
- Task Spec: {taskMdPath}
- Output Path: {outputPath}

## Instructions
Process the task and generate output.
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

  describe('Constructor', () => {
    it('should create SkillAgent with absolute skill path', () => {
      const agent = new SkillAgent(mockConfig, skillPath);

      expect(agent.type).toBe('skill');
      expect(agent.name).toBe('test-skill');
    });

    it('should create SkillAgent with relative skill path', () => {
      const agent = new SkillAgent(mockConfig, 'skills/evaluator/SKILL.md');

      expect(agent.type).toBe('skill');
      expect(agent.name).toBe('SKILL');
    });

    it('should extract skill name from path with multiple directories', () => {
      const agent = new SkillAgent(mockConfig, 'path/to/skills/my-agent/PROMPT.md');

      expect(agent.name).toBe('PROMPT');
    });

    it('should extract skill name from simple filename', () => {
      const agent = new SkillAgent(mockConfig, 'simple.md');

      expect(agent.name).toBe('simple');
    });

    it('should accept all config options', () => {
      const fullConfig: BaseAgentConfig = {
        apiKey: 'test-key',
        model: 'claude-3-opus',
        provider: 'anthropic',
        apiBaseUrl: 'https://custom.api.com',
        permissionMode: 'bypassPermissions',
      };

      const agent = new SkillAgent(fullConfig, skillPath);
      expect(agent).toBeDefined();
    });
  });

  describe('Initialization', () => {
    it('should initialize properly', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      // Should be idempotent
      agent.initialize();
    });

    it('should auto-initialize on executeWithContext', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      // Don't call initialize() explicitly
      const generator = agent.executeWithContext();
      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should auto-initialize on execute', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      // Don't call initialize() explicitly
      const generator = agent.execute('test input');
      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });
  });

  describe('Disposal', () => {
    it('should dispose properly', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      agent.dispose();

      // Should be safe to call dispose multiple times
      agent.dispose();
    });

    it('should dispose without initialization', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      // Don't initialize
      agent.dispose();
      // Should not throw
    });
  });

  describe('executeWithContext', () => {
    it('should return an async generator', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.executeWithContext();
      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should accept empty options', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.executeWithContext({});
      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should accept template variables', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.executeWithContext({
        templateVars: {
          taskId: 'task-123',
          iteration: '1',
          customVar: 'custom-value',
        },
      });

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should accept partial template variables', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.executeWithContext({
        templateVars: {
          taskId: 'task-456',
        },
      });

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });
  });

  describe('execute method', () => {
    it('should accept string input', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.execute('test input');

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should accept empty string input', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.execute('');

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should accept UserInput array', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.execute([
        { role: 'user', content: 'test input 1' },
        { role: 'user', content: 'test input 2' },
      ]);

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should accept empty UserInput array', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.execute([]);

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should accept UserInput array with single item', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.execute([
        { role: 'user', content: 'single input' },
      ]);

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should handle multiline input', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const multilineInput = `Line 1
Line 2
Line 3`;

      const generator = agent.execute(multilineInput);

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });
  });

  describe('Template Variable Substitution', () => {
    it('should handle skill with no template variables', async () => {
      const noVarPath = path.join(tempDir, 'no-vars.md');
      await fs.writeFile(noVarPath, '# Simple Skill\n\nNo variables here.');

      const agent = new SkillAgent(mockConfig, noVarPath);
      agent.initialize();

      const generator = agent.executeWithContext({
        templateVars: {
          unusedVar: 'value',
        },
      });

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should handle skill with many template variables', async () => {
      const complexPath = path.join(tempDir, 'complex.md');
      await fs.writeFile(complexPath, COMPLEX_SKILL_CONTENT);

      const agent = new SkillAgent(mockConfig, complexPath);
      agent.initialize();

      const generator = agent.executeWithContext({
        templateVars: {
          taskId: 'task-789',
          iteration: '5',
          taskMdPath: '/path/to/Task.md',
          outputPath: '/path/to/output.md',
        },
      });

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should handle missing template variables gracefully', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      // Only provide one variable, others remain as placeholders
      const generator = agent.executeWithContext({
        templateVars: {
          taskId: 'only-this',
        },
      });

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should handle special characters in template values', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.executeWithContext({
        templateVars: {
          taskId: 'task-with-special-chars!@#$%',
          iteration: '1',
          customVar: 'value with spaces and "quotes"',
        },
      });

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should handle unicode in template values', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.executeWithContext({
        templateVars: {
          taskId: '任务-123',
          iteration: '第一轮',
          customVar: '日本語テスト',
        },
      });

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });
  });

  describe('File Handling', () => {
    it('should handle skill file with frontmatter-like content', async () => {
      const frontmatterPath = path.join(tempDir, 'frontmatter.md');
      await fs.writeFile(frontmatterPath, `---
This looks like frontmatter but isn't parsed
---
# Skill Content
{taskId}
`);

      const agent = new SkillAgent(mockConfig, frontmatterPath);
      agent.initialize();

      const generator = agent.executeWithContext({
        templateVars: { taskId: 'test' },
      });

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should handle large skill files', async () => {
      const largePath = path.join(tempDir, 'large.md');
      const largeContent = '# Large Skill\n\n' + 'Line content\n'.repeat(1000);
      await fs.writeFile(largePath, largeContent);

      const agent = new SkillAgent(mockConfig, largePath);
      agent.initialize();

      const generator = agent.execute('test');
      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });

    it('should handle skill files with code blocks', async () => {
      const codeBlockPath = path.join(tempDir, 'codeblock.md');
      await fs.writeFile(codeBlockPath, `# Skill with Code

\`\`\`typescript
const example = "{taskId}";
\`\`\`

Task: {taskId}
`);

      const agent = new SkillAgent(mockConfig, codeBlockPath);
      agent.initialize();

      const generator = agent.executeWithContext({
        templateVars: { taskId: 'task-code' },
      });

      expect(generator[Symbol.asyncIterator]).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should throw on non-existent skill file with executeWithContext', async () => {
      const agent = new SkillAgent(mockConfig, '/non/existent/skill.md');
      agent.initialize();

      const generator = agent.executeWithContext();

      // Iterating should throw ENOENT error
      await expect(async () => {
        for await (const _ of generator) {
          // Should not reach here
        }
      }).rejects.toThrow(/ENOENT/);
    });

    it('should throw on non-existent skill file with execute', async () => {
      const agent = new SkillAgent(mockConfig, '/non/existent/skill.md');
      agent.initialize();

      const generator = agent.execute('test input');

      // Iterating should throw ENOENT error
      await expect(async () => {
        for await (const _ of generator) {
          // Should not reach here
        }
      }).rejects.toThrow(/ENOENT/);
    });
  });

  describe('Agent Properties', () => {
    it('should have correct type', () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      expect(agent.type).toBe('skill');
    });

    it('should have name derived from filename', () => {
      const customPath = path.join(tempDir, 'my-custom-skill.md');
      const agent = new SkillAgent(mockConfig, customPath);
      expect(agent.name).toBe('my-custom-skill');
    });

    it('should handle .md extension in name extraction', () => {
      const agent = new SkillAgent(mockConfig, 'test.md');
      expect(agent.name).toBe('test');
    });
  });

  describe('Multiple Instances', () => {
    it('should allow multiple independent instances', () => {
      const agent1 = new SkillAgent(mockConfig, skillPath);
      const skill2Path = path.join(tempDir, 'skill2.md');
      const agent2 = new SkillAgent(mockConfig, skill2Path);

      expect(agent1.name).toBe('test-skill');
      expect(agent2.name).toBe('skill2');
    });

    it('should allow independent initialization', () => {
      const agent1 = new SkillAgent(mockConfig, skillPath);
      const skill2Path = path.join(tempDir, 'skill2.md');
      const agent2 = new SkillAgent(mockConfig, skill2Path);

      agent1.initialize();
      // agent2 not initialized

      // Both should work
      const gen1 = agent1.executeWithContext();
      const gen2 = agent2.executeWithContext();

      expect(gen1[Symbol.asyncIterator]).toBeDefined();
      expect(gen2[Symbol.asyncIterator]).toBeDefined();
    });
  });
});
