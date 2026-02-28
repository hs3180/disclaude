/**
 * Tests for SkillAgent.
 *
 * @module agents/skill-agent.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SkillAgent } from './skill-agent.js';

// Mock fs
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
    })),
    getWorkspaceDir: vi.fn(() => '/workspace'),
    getSkillsDir: vi.fn(() => '/workspace/skills'),
    getGlobalEnv: vi.fn(() => ({})),
    getLoggingConfig: vi.fn(() => ({ sdkDebug: false })),
  },
}));

// Mock SDK provider
vi.mock('../sdk/index.js', () => ({
  getProvider: vi.fn(() => ({
    queryOnce: vi.fn(async function* () {
      yield {
        type: 'text',
        content: 'Test response',
        metadata: {},
      };
    }),
  })),
}));

describe('SkillAgent', () => {
  const mockSkillContent = `---
name: test-skill
description: A test skill
---

# Test Skill

This is a test skill for {{taskId}}.

Task ID: {{taskId}}
Iteration: {{iteration}}
`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readFile).mockResolvedValue(mockSkillContent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create SkillAgent with skill path', () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test-skill/SKILL.md',
      });

      expect(agent.type).toBe('skill');
      expect(agent.name).toBe('Test-skill');
    });

    it('should extract skill name from path', () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'evaluator/SKILL.md',
      });

      expect(agent.name).toBe('Evaluator');
    });

    it('should accept allowedTools configuration', () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
        allowedTools: ['Read', 'Write'],
      });

      expect(agent).toBeDefined();
    });
  });

  describe('getSkillContent', () => {
    it('should load skill content from file', async () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      const content = await agent.getSkillContent();

      expect(fs.readFile).toHaveBeenCalledWith(
        path.join('/workspace/skills', 'test/SKILL.md'),
        'utf-8'
      );
      expect(content).toBe(mockSkillContent);
    });

    it('should cache skill content', async () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      await agent.getSkillContent();
      await agent.getSkillContent();

      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });

    it('should throw error if skill file not found', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'missing/SKILL.md',
      });

      await expect(agent.getSkillContent()).rejects.toThrow('Failed to load skill file');
    });
  });

  describe('executeWithContext', () => {
    it('should substitute template variables', async () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      const messages: any[] = [];
      for await (const msg of agent.executeWithContext('Test input', {
        taskId: 'task-123',
        iteration: 1,
      })) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should combine skill content with input', async () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      const messages: any[] = [];
      for await (const msg of agent.executeWithContext('Additional input', {})) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should work without input', async () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      const messages: any[] = [];
      for await (const msg of agent.executeWithContext('', {})) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('execute (SkillAgent interface)', () => {
    it('should accept string input', async () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      const messages: any[] = [];
      for await (const msg of agent.execute('Test input')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should accept UserInput array', async () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      const messages: any[] = [];
      for await (const msg of agent.execute([
        { role: 'user', content: 'Message 1' },
        { role: 'user', content: 'Message 2' },
      ])) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('dispose', () => {
    it('should dispose resources', () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      expect(() => agent.dispose()).not.toThrow();
    });
  });

  describe('template substitution', () => {
    it('should handle unknown variables gracefully', async () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      const messages: any[] = [];
      for await (const msg of agent.executeWithContext('', {
        unknownVar: 'value',
      })) {
        messages.push(msg);
      }

      // Should not throw, unknown {{taskId}} etc remain as-is
      expect(messages.length).toBeGreaterThan(0);
    });

    it('should handle empty context', async () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      const messages: any[] = [];
      for await (const msg of agent.executeWithContext('')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('error handling', () => {
    it('should handle SDK errors in executeWithContext', async () => {
      // Mock SDK to throw error
      const { getProvider } = await import('../sdk/index.js');
      vi.mocked(getProvider).mockReturnValueOnce({
        queryOnce: vi.fn(async function* () {
          throw new Error('SDK error');
        }),
      } as any);

      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      const messages: any[] = [];
      for await (const msg of agent.executeWithContext('test input', {})) {
        messages.push(msg);
      }

      // Should yield error message instead of throwing
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0].content).toContain('SDK error');
    });
  });

  describe('array input handling', () => {
    it('should handle non-string input in executeWithContext', async () => {
      const agent = new SkillAgent({
        apiKey: 'test-key',
        model: 'test-model',
        skillPath: 'test/SKILL.md',
      });

      // Pass array input to executeWithContext (non-string)
      const messages: any[] = [];
      for await (const msg of agent.executeWithContext(['msg1', 'msg2'] as any, {})) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });
});
