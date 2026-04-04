/**
 * Tests for ModeManager - per-chat agent mode state management.
 *
 * Issue #1709: Research Mode - SOUL + cwd + Skill set switching.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ModeManager } from './mode-manager.js';
import { sanitizeTopicName, generateResearchSoulContent, createResearchModeConfig } from './research-soul.js';

describe('sanitizeTopicName', () => {
  it('should lowercase the topic', () => {
    expect(sanitizeTopicName('Machine Learning')).toBe('machine-learning');
  });

  it('should replace spaces with hyphens', () => {
    expect(sanitizeTopicName('hello world')).toBe('hello-world');
  });

  it('should remove special characters except hyphens and underscores', () => {
    expect(sanitizeTopicName('test@#$%^&*()')).toBe('test');
  });

  it('should collapse multiple hyphens', () => {
    expect(sanitizeTopicName('a---b')).toBe('a-b');
  });

  it('should remove leading and trailing hyphens', () => {
    expect(sanitizeTopicName('-hello-')).toBe('hello');
  });

  it('should support Chinese characters', () => {
    expect(sanitizeTopicName('机器学习研究')).toBe('机器学习研究');
  });

  it('should support mixed Chinese and alphanumeric', () => {
    expect(sanitizeTopicName('AI与机器学习')).toBe('ai与机器学习');
  });

  it('should limit length to 64 characters', () => {
    const longTopic = 'a'.repeat(100);
    expect(sanitizeTopicName(longTopic).length).toBe(64);
  });

  it('should return "untitled" for empty or only-special-char input', () => {
    expect(sanitizeTopicName('')).toBe('untitled');
    expect(sanitizeTopicName('@#$%')).toBe('untitled');
  });

  it('should handle numbers', () => {
    expect(sanitizeTopicName('Web3 and Crypto')).toBe('web3-and-crypto');
  });

  it('should trim whitespace', () => {
    expect(sanitizeTopicName('  hello  ')).toBe('hello');
  });
});

describe('generateResearchSoulContent', () => {
  it('should include the topic name in the content', () => {
    const content = generateResearchSoulContent('machine-learning');
    expect(content).toContain('machine-learning');
  });

  it('should include directory access rules', () => {
    const content = generateResearchSoulContent('test');
    expect(content).toContain('Directory Access Rules');
    expect(content).toContain('Allowed');
    expect(content).toContain('Prohibited');
  });

  it('should include research methodology', () => {
    const content = generateResearchSoulContent('test');
    expect(content).toContain('Research Methodology');
  });

  it('should include output guidelines', () => {
    const content = generateResearchSoulContent('test');
    expect(content).toContain('Output Guidelines');
  });
});

describe('createResearchModeConfig', () => {
  it('should create config with sanitized topic', () => {
    const config = createResearchModeConfig('Machine Learning', '/app/workspace');
    expect(config.topic).toBe('machine-learning');
  });

  it('should set correct cwd path', () => {
    const config = createResearchModeConfig('test-topic', '/app/workspace');
    expect(config.cwd).toBe('/app/workspace/workspace/research/test-topic');
  });

  it('should include soul content', () => {
    const config = createResearchModeConfig('test', '/app/workspace');
    expect(config.soulContent).toContain('test');
    expect(config.soulContent).toContain('Research Mode Active');
  });

  it('should set activation timestamp', () => {
    const config = createResearchModeConfig('test', '/app/workspace');
    expect(config.activatedAt).toBeDefined();
    expect(new Date(config.activatedAt).getTime()).not.toBeNaN();
  });
});

describe('ModeManager', () => {
  let manager: ModeManager;

  beforeEach(() => {
    manager = new ModeManager({ workspaceDir: '/test/workspace' });
  });

  describe('getMode', () => {
    it('should return "normal" for unknown chat', () => {
      expect(manager.getMode('unknown-chat')).toBe('normal');
    });

    it('should return current mode after switching', () => {
      manager.switchToResearch('chat-1', 'test-topic');
      expect(manager.getMode('chat-1')).toBe('research');
    });

    it('should return "normal" for different chats', () => {
      manager.switchToResearch('chat-1', 'test-topic');
      expect(manager.getMode('chat-2')).toBe('normal');
    });
  });

  describe('getModeState', () => {
    it('should return default normal state for unknown chat', () => {
      const state = manager.getModeState('unknown-chat');
      expect(state).toEqual({ mode: 'normal' });
    });

    it('should return full state including research config', () => {
      const state = manager.switchToResearch('chat-1', 'test-topic');
      const retrieved = manager.getModeState('chat-1');
      expect(retrieved.mode).toBe('research');
      expect(retrieved.research).toBeDefined();
      expect(retrieved.research?.topic).toBe('test-topic');
    });
  });

  describe('isResearchMode', () => {
    it('should return false for unknown chat', () => {
      expect(manager.isResearchMode('unknown-chat')).toBe(false);
    });

    it('should return true after switching to research', () => {
      manager.switchToResearch('chat-1', 'test-topic');
      expect(manager.isResearchMode('chat-1')).toBe(true);
    });

    it('should return false after switching back to normal', () => {
      manager.switchToResearch('chat-1', 'test-topic');
      manager.switchToNormal('chat-1');
      expect(manager.isResearchMode('chat-1')).toBe(false);
    });
  });

  describe('switchToResearch', () => {
    it('should create research config with correct cwd', () => {
      const state = manager.switchToResearch('chat-1', 'machine-learning');
      expect(state.mode).toBe('research');
      expect(state.research?.cwd).toBe('/test/workspace/workspace/research/machine-learning');
      expect(state.research?.topic).toBe('machine-learning');
    });

    it('should include soul content', () => {
      const state = manager.switchToResearch('chat-1', 'test');
      expect(state.research?.soulContent).toContain('test');
    });

    it('should set activation timestamp', () => {
      const state = manager.switchToResearch('chat-1', 'test');
      expect(state.research?.activatedAt).toBeDefined();
    });

    it('should return existing state for same topic', () => {
      const state1 = manager.switchToResearch('chat-1', 'test-topic');
      const state2 = manager.switchToResearch('chat-1', 'test-topic');
      expect(state1).toBe(state2); // Same reference
    });

    it('should create new state for different topic', () => {
      const state1 = manager.switchToResearch('chat-1', 'topic-a');
      const state2 = manager.switchToResearch('chat-1', 'topic-b');
      expect(state1).not.toBe(state2);
      expect(state2.research?.topic).toBe('topic-b');
    });

    it('should sanitize topic name', () => {
      const state = manager.switchToResearch('chat-1', 'Machine Learning!');
      expect(state.research?.topic).toBe('machine-learning');
    });
  });

  describe('switchToNormal', () => {
    it('should return normal mode state', () => {
      manager.switchToResearch('chat-1', 'test');
      const state = manager.switchToNormal('chat-1');
      expect(state.mode).toBe('normal');
      expect(state.research).toBeUndefined();
    });

    it('should return normal state for already-normal chat', () => {
      const state = manager.switchToNormal('chat-1');
      expect(state.mode).toBe('normal');
    });

    it('should clear research config', () => {
      manager.switchToResearch('chat-1', 'test');
      manager.switchToNormal('chat-1');
      expect(manager.getResearchCwd('chat-1')).toBeUndefined();
      expect(manager.getResearchSoul('chat-1')).toBeUndefined();
    });
  });

  describe('clearState', () => {
    it('should remove mode state for a chat', () => {
      manager.switchToResearch('chat-1', 'test');
      manager.clearState('chat-1');
      expect(manager.getMode('chat-1')).toBe('normal');
    });

    it('should not affect other chats', () => {
      manager.switchToResearch('chat-1', 'test');
      manager.switchToResearch('chat-2', 'other');
      manager.clearState('chat-1');
      expect(manager.getMode('chat-2')).toBe('research');
    });
  });

  describe('clearAll', () => {
    it('should remove all mode states', () => {
      manager.switchToResearch('chat-1', 'test-1');
      manager.switchToResearch('chat-2', 'test-2');
      manager.switchToResearch('chat-3', 'test-3');
      manager.clearAll();
      expect(manager.getMode('chat-1')).toBe('normal');
      expect(manager.getMode('chat-2')).toBe('normal');
      expect(manager.getMode('chat-3')).toBe('normal');
    });
  });

  describe('getResearchCwd', () => {
    it('should return cwd when in research mode', () => {
      manager.switchToResearch('chat-1', 'test');
      expect(manager.getResearchCwd('chat-1')).toBe('/test/workspace/workspace/research/test');
    });

    it('should return undefined when not in research mode', () => {
      expect(manager.getResearchCwd('chat-1')).toBeUndefined();
    });
  });

  describe('getResearchSoul', () => {
    it('should return soul content when in research mode', () => {
      manager.switchToResearch('chat-1', 'test');
      expect(manager.getResearchSoul('chat-1')).toContain('test');
    });

    it('should return undefined when not in research mode', () => {
      expect(manager.getResearchSoul('chat-1')).toBeUndefined();
    });
  });

  describe('getResearchModeCount', () => {
    it('should return 0 when no chats are in research mode', () => {
      expect(manager.getResearchModeCount()).toBe(0);
    });

    it('should count chats in research mode', () => {
      manager.switchToResearch('chat-1', 'test-1');
      manager.switchToResearch('chat-2', 'test-2');
      expect(manager.getResearchModeCount()).toBe(2);
    });

    it('should not count chats switched back to normal', () => {
      manager.switchToResearch('chat-1', 'test-1');
      manager.switchToResearch('chat-2', 'test-2');
      manager.switchToNormal('chat-1');
      expect(manager.getResearchModeCount()).toBe(1);
    });
  });

  describe('getResearchModeChatIds', () => {
    it('should return empty array when no research modes', () => {
      expect(manager.getResearchModeChatIds()).toEqual([]);
    });

    it('should return chat IDs in research mode', () => {
      manager.switchToResearch('chat-1', 'test-1');
      manager.switchToResearch('chat-2', 'test-2');
      manager.switchToResearch('chat-3', 'test-3');
      const ids = manager.getResearchModeChatIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('chat-1');
      expect(ids).toContain('chat-2');
      expect(ids).toContain('chat-3');
    });
  });
});
