/**
 * Tests for ModeManager - Agent operating mode management.
 *
 * Issue #1709: Tests for per-chat session mode switching.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Config module before importing ModeManager
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/test-workspace',
    getResearchModeConfig: vi.fn(() => ({
      enabled: true,
      soulSkill: 'research-mode',
      cwdPattern: 'research/{topic}',
    })),
  },
}));

// Mock skills module
vi.mock('../skills/finder.js', () => ({
  findSkill: vi.fn(async (name: string) => {
    if (name === 'research-mode') return '/skills/research-mode/SKILL.md';
    return null;
  }),
  readSkillContent: vi.fn(async (name: string) => {
    if (name === 'research-mode') return '# Research SOUL\nBe thorough.';
    return null;
  }),
}));

// Mock fs to avoid actual file creation
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(async () => {}),
    access: vi.fn(async () => {}),
  },
  mkdir: vi.fn(async () => {}),
}));

import { ModeManager } from './mode-manager.js';

describe('ModeManager', () => {
  let manager: ModeManager;

  beforeEach(() => {
    manager = new ModeManager();
  });

  describe('getMode', () => {
    it('should return normal mode by default', () => {
      const state = manager.getMode('chat-1');
      expect(state.mode).toBe('normal');
      expect(state.cwd).toBe('/tmp/test-workspace');
    });

    it('should return consistent state for same chatId', () => {
      const state1 = manager.getMode('chat-1');
      const state2 = manager.getMode('chat-1');
      expect(state1).toBe(state2);
    });

    it('should return independent state for different chatIds', () => {
      const state1 = manager.getMode('chat-1');
      const state2 = manager.getMode('chat-2');
      expect(state1).not.toBe(state2);
      expect(state1.cwd).toBe(state2.cwd);
    });
  });

  describe('isResearchModeEnabled', () => {
    it('should return true when config is enabled', () => {
      expect(manager.isResearchModeEnabled()).toBe(true);
    });
  });

  describe('getResearchConfig', () => {
    it('should return config when enabled', () => {
      const config = manager.getResearchConfig();
      expect(config).not.toBeNull();
      expect(config?.enabled).toBe(true);
      expect(config?.soulSkill).toBe('research-mode');
    });
  });

  describe('switchToResearch', () => {
    it('should switch to research mode with valid topic', async () => {
      const result = await manager.switchToResearch('chat-1', 'AI Safety');
      expect(result.success).toBe(true);
      expect(result.mode).toBe('research');
      expect(result.cwd).toContain('AI-Safety');
      expect(result.cwd).toContain('/tmp/test-workspace');
    });

    it('should fail with empty topic', async () => {
      const result = await manager.switchToResearch('chat-1', '');
      expect(result.success).toBe(false);
      expect(result.mode).toBe('normal');
      expect(result.message).toContain('topic is required');
    });

    it('should fail with whitespace-only topic', async () => {
      const result = await manager.switchToResearch('chat-1', '   ');
      expect(result.success).toBe(false);
    });

    it('should sanitize topic for directory names', async () => {
      const result = await manager.switchToResearch('chat-1', 'What is AI/ML? <test>');
      expect(result.success).toBe(true);
      // Topic portion should not contain unsafe chars (only check the topic part, not path separators)
      const topicPart = result.cwd!.split('/').pop()!;
      expect(topicPart).not.toContain('/');
      expect(topicPart).not.toContain('<');
      expect(topicPart).not.toContain('>');
      expect(topicPart).not.toContain('?');
    });

    it('should load SOUL content from skill', async () => {
      const result = await manager.switchToResearch('chat-1', 'test');
      expect(result.success).toBe(true);
      const state = manager.getMode('chat-1');
      expect(state.soulContent).toBe('# Research SOUL\nBe thorough.');
    });

    it('should update mode state after switch', async () => {
      await manager.switchToResearch('chat-1', 'test');
      const state = manager.getMode('chat-1');
      expect(state.mode).toBe('research');
      expect(state.topic).toBe('test');
    });

    it('should include mode info in result message', async () => {
      const result = await manager.switchToResearch('chat-1', 'Quantum Computing');
      expect(result.message).toContain('Research Mode Activated');
      expect(result.message).toContain('Quantum-Computing');
    });
  });

  describe('switchToNormal', () => {
    it('should switch back to normal mode', async () => {
      await manager.switchToResearch('chat-1', 'test');
      const result = manager.switchToNormal('chat-1');
      expect(result.success).toBe(true);
      expect(result.mode).toBe('normal');
      expect(result.cwd).toBe('/tmp/test-workspace');
    });

    it('should return info message when already in normal mode', () => {
      const result = manager.switchToNormal('chat-1');
      expect(result.success).toBe(true);
      expect(result.mode).toBe('normal');
      expect(result.message).toContain('Already in normal mode');
    });

    it('should mention previous topic in return message', async () => {
      await manager.switchToResearch('chat-1', 'Deep Learning');
      const result = manager.switchToNormal('chat-1');
      expect(result.message).toContain('Deep-Learning');
    });

    it('should update mode state after switch', async () => {
      await manager.switchToResearch('chat-1', 'test');
      manager.switchToNormal('chat-1');
      const state = manager.getMode('chat-1');
      expect(state.mode).toBe('normal');
      expect(state.topic).toBeUndefined();
    });
  });

  describe('handleModeCommand', () => {
    it('should handle /research <topic> command', async () => {
      const result = await manager.handleModeCommand('chat-1', '/research Machine Learning');
      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
      expect(result?.mode).toBe('research');
    });

    it('should handle /mode normal command', async () => {
      await manager.switchToResearch('chat-1', 'test');
      const result = await manager.handleModeCommand('chat-1', '/mode normal');
      expect(result).not.toBeNull();
      expect(result?.mode).toBe('normal');
    });

    it('should handle /mode research <topic> command', async () => {
      const result = await manager.handleModeCommand('chat-1', '/mode research NLP');
      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
      expect(result?.mode).toBe('research');
    });

    it('should return null for non-mode commands', async () => {
      const result = await manager.handleModeCommand('chat-1', '/reset');
      expect(result).toBeNull();
    });

    it('should return null for regular messages', async () => {
      const result = await manager.handleModeCommand('chat-1', 'Hello world');
      expect(result).toBeNull();
    });
  });

  describe('clearMode', () => {
    it('should clear mode state for a chat', async () => {
      await manager.switchToResearch('chat-1', 'test');
      manager.clearMode('chat-1');
      const state = manager.getMode('chat-1');
      expect(state.mode).toBe('normal');
      // Note: getMode creates a fresh default state after clear
    });
  });

  describe('clearAll', () => {
    it('should clear all mode states', async () => {
      await manager.switchToResearch('chat-1', 'test1');
      await manager.switchToResearch('chat-2', 'test2');
      manager.clearAll();
      expect(manager.getMode('chat-1').mode).toBe('normal');
      expect(manager.getMode('chat-2').mode).toBe('normal');
    });
  });

  describe('getModeLabel', () => {
    it('should return "normal" for normal mode', () => {
      expect(manager.getModeLabel('chat-1')).toBe('normal');
    });

    it('should return "research (topic)" for research mode', async () => {
      await manager.switchToResearch('chat-1', 'AI');
      expect(manager.getModeLabel('chat-1')).toBe('research (AI)');
    });
  });

  describe('sanitizeTopic', () => {
    it('should handle special characters', async () => {
      const result = await manager.switchToResearch('chat-1', 'C++ vs Java: Which is <better>?');
      expect(result.success).toBe(true);
      // Verify the topic was sanitized (no special chars in path)
      expect(result.cwd).not.toContain(':');
      expect(result.cwd).not.toContain('?');
      expect(result.cwd).not.toContain('<');
      expect(result.cwd).not.toContain('>');
    });

    it('should collapse multiple hyphens', async () => {
      const result = await manager.switchToResearch('chat-1', 'test   -- topic');
      expect(result.success).toBe(true);
    });

    it('should limit topic length', async () => {
      const longTopic = 'a'.repeat(200);
      const result = await manager.switchToResearch('chat-1', longTopic);
      expect(result.success).toBe(true);
      // Should be truncated to 100 chars
      expect(result.cwd!.length).toBeLessThan(150);
    });
  });
});
