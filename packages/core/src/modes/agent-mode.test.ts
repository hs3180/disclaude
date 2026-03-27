/**
 * Tests for Agent Mode Management (Research Mode).
 *
 * Issue #1709: Research Mode — Phase 1
 *
 * Uses real filesystem via temp directories (no mocks for fs operations).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  ResearchModeManager,
  sanitizeTopicName,
} from './agent-mode.js';

describe('sanitizeTopicName', () => {
  it('should lowercase and replace spaces with hyphens', () => {
    expect(sanitizeTopicName('My Research Topic')).toBe('my-research-topic');
  });

  it('should replace underscores with hyphens', () => {
    expect(sanitizeTopicName('my_research_topic')).toBe('my-research-topic');
  });

  it('should remove special characters', () => {
    expect(sanitizeTopicName('Hello, World!')).toBe('hello-world');
  });

  it('should handle CJK characters', () => {
    const result = sanitizeTopicName('AI 安全研究');
    expect(result).toContain('ai');
    expect(result).toContain('安全研究');
  });

  it('should limit to 64 characters', () => {
    const longTopic = 'a'.repeat(100);
    const result = sanitizeTopicName(longTopic);
    expect(result.length).toBeLessThanOrEqual(64);
  });

  it('should fallback to untitled for empty-like input', () => {
    expect(sanitizeTopicName('!!!')).toBe('untitled');
    expect(sanitizeTopicName('')).toBe('untitled');
  });

  it('should collapse multiple hyphens', () => {
    expect(sanitizeTopicName('hello -- world')).toBe('hello-world');
  });

  it('should trim leading/trailing hyphens', () => {
    expect(sanitizeTopicName('--hello--')).toBe('hello');
  });

  it('should handle mixed CJK and ASCII', () => {
    const result = sanitizeTopicName('深度学习 Deep Learning');
    expect(result).toContain('深度学习');
    expect(result).toContain('deep-learning');
  });
});

describe('ResearchModeManager', () => {
  let tempDir: string;
  let manager: ResearchModeManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-mode-test-'));
    manager = new ResearchModeManager();
  });

  afterEach(async () => {
    manager.clearAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getMode', () => {
    it('should return normal by default', () => {
      expect(manager.getMode('chat-1')).toBe('normal');
    });

    it('should return research after entering research mode', async () => {
      await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });
      expect(manager.getMode('chat-1')).toBe('research');
    });

    it('should return normal for different chatIds', async () => {
      await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });
      expect(manager.getMode('chat-2')).toBe('normal');
    });
  });

  describe('isResearchMode', () => {
    it('should return false by default', () => {
      expect(manager.isResearchMode('chat-1')).toBe(false);
    });

    it('should return true after entering research mode', async () => {
      await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });
      expect(manager.isResearchMode('chat-1')).toBe(true);
    });
  });

  describe('enterResearchMode', () => {
    it('should create research workspace directory', async () => {
      const result = await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });

      const stat = await fs.stat(result.workspaceDir);
      expect(stat.isDirectory()).toBe(true);
      expect(result.workspaceDir).toContain('test-research');
    });

    it('should create CLAUDE.md (SOUL) file', async () => {
      const result = await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });

      const content = await fs.readFile(result.soulFilePath, 'utf-8');
      expect(content).toContain('# Research Mode');
      expect(content).toContain('Research Behavior');
    });

    it('should not overwrite existing CLAUDE.md', async () => {
      // Enter research mode twice for same topic
      await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });

      // Manually modify CLAUDE.md
      const firstResult = manager.getResearchInfo('chat-1');
      const soulPath = path.join(firstResult!.workspaceDir, 'CLAUDE.md');
      await fs.writeFile(soulPath, '# Custom SOUL\n', 'utf-8');

      // Exit and re-enter
      manager.exitResearchMode('chat-1');
      const result = await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });

      const content = await fs.readFile(result.soulFilePath, 'utf-8');
      expect(content).toContain('# Custom SOUL');
      expect(content).not.toContain('# Research Mode');
    });

    it('should create notes and sources subdirectories', async () => {
      const result = await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });

      for (const subDir of ['notes', 'sources']) {
        const subPath = path.join(result.workspaceDir, subDir);
        const stat = await fs.stat(subPath);
        expect(stat.isDirectory()).toBe(true);
      }
    });

    it('should store research state', async () => {
      await manager.enterResearchMode('chat-1', {
        topic: 'AI Safety Research',
        workspaceBaseDir: tempDir,
      });

      const info = manager.getResearchInfo('chat-1');
      expect(info).toBeDefined();
      expect(info!.topic).toBe('AI Safety Research');
      expect(info!.workspaceDir).toContain('ai-safety-research');
      expect(info!.enteredAt).toBeInstanceOf(Date);
    });

    it('should throw error for empty topic', async () => {
      await expect(
        manager.enterResearchMode('chat-1', {
          topic: '',
          workspaceBaseDir: tempDir,
        })
      ).rejects.toThrow('Research topic is required');
    });

    it('should throw error for whitespace-only topic', async () => {
      await expect(
        manager.enterResearchMode('chat-1', {
          topic: '   ',
          workspaceBaseDir: tempDir,
        })
      ).rejects.toThrow('Research topic is required');
    });

    it('should sanitize topic for directory name', async () => {
      const result = await manager.enterResearchMode('chat-1', {
        topic: 'C++ & Rust Comparison!',
        workspaceBaseDir: tempDir,
      });

      expect(result.workspaceDir).toContain('c-rust-comparison');
      expect(result.workspaceDir).not.toContain('++');
      expect(result.workspaceDir).not.toContain('!');
    });

    it('should support CJK topic names', async () => {
      const result = await manager.enterResearchMode('chat-1', {
        topic: 'AI 大模型安全研究',
        workspaceBaseDir: tempDir,
      });

      expect(result.workspaceDir).toContain('ai-大模型安全研究');
    });

    it('should be idempotent for same chatId', async () => {
      await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });
      await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });

      const chats = manager.getActiveResearchChats();
      expect(chats).toHaveLength(1);
    });
  });

  describe('exitResearchMode', () => {
    it('should return to normal mode', async () => {
      await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });

      const result = manager.exitResearchMode('chat-1');
      expect(result).toBe(true);
      expect(manager.getMode('chat-1')).toBe('normal');
    });

    it('should return false if not in research mode', () => {
      const result = manager.exitResearchMode('chat-1');
      expect(result).toBe(false);
    });

    it('should NOT delete research workspace directory', async () => {
      const result = await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });

      manager.exitResearchMode('chat-1');

      // Directory should still exist
      const stat = await fs.stat(result.workspaceDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should clear research info', async () => {
      await manager.enterResearchMode('chat-1', {
        topic: 'Test Research',
        workspaceBaseDir: tempDir,
      });

      manager.exitResearchMode('chat-1');

      expect(manager.getResearchInfo('chat-1')).toBeUndefined();
    });
  });

  describe('getActiveResearchChats', () => {
    it('should return empty array when no chats in research mode', () => {
      expect(manager.getActiveResearchChats()).toEqual([]);
    });

    it('should return all chatIds in research mode', async () => {
      await manager.enterResearchMode('chat-1', {
        topic: 'Topic 1',
        workspaceBaseDir: tempDir,
      });
      await manager.enterResearchMode('chat-2', {
        topic: 'Topic 2',
        workspaceBaseDir: tempDir,
      });

      const chats = manager.getActiveResearchChats();
      expect(chats).toHaveLength(2);
      expect(chats).toContain('chat-1');
      expect(chats).toContain('chat-2');
    });
  });

  describe('clearAll', () => {
    it('should clear all research mode states', async () => {
      await manager.enterResearchMode('chat-1', {
        topic: 'Topic 1',
        workspaceBaseDir: tempDir,
      });
      await manager.enterResearchMode('chat-2', {
        topic: 'Topic 2',
        workspaceBaseDir: tempDir,
      });

      manager.clearAll();

      expect(manager.getActiveResearchChats()).toEqual([]);
      expect(manager.getMode('chat-1')).toBe('normal');
      expect(manager.getMode('chat-2')).toBe('normal');
    });
  });
});
