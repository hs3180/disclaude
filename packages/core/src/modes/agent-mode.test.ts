/**
 * Tests for Research Mode management (packages/core/src/modes/agent-mode.ts)
 *
 * Issue #1709: 增加 Research 模式
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sanitizeTopicName, ResearchModeManager } from './agent-mode.js';

describe('sanitizeTopicName', () => {
  it('should sanitize basic topic names', () => {
    expect(sanitizeTopicName('AI Safety')).toBe('ai-safety');
  });

  it('should handle CJK characters', () => {
    expect(sanitizeTopicName('人工智能安全')).toBe('人工智能安全');
  });

  it('should handle mixed CJK and ASCII', () => {
    expect(sanitizeTopicName('AI安全研究')).toBe('ai安全研究');
  });

  it('should replace invalid characters with hyphens', () => {
    expect(sanitizeTopicName('what/is:this')).toBe('what-is-this');
  });

  it('should replace multiple spaces/hyphens with single hyphen', () => {
    expect(sanitizeTopicName('hello   world')).toBe('hello-world');
    expect(sanitizeTopicName('hello---world')).toBe('hello-world');
  });

  it('should remove leading/trailing hyphens and dots', () => {
    expect(sanitizeTopicName('...hello...')).toBe('hello');
    expect(sanitizeTopicName('---hello---')).toBe('hello');
  });

  it('should limit length to 100 characters', () => {
    const longTopic = 'a'.repeat(200);
    const result = sanitizeTopicName(longTopic);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('should lowercase ASCII characters', () => {
    expect(sanitizeTopicName('HELLO WORLD')).toBe('hello-world');
  });

  it('should preserve numbers', () => {
    expect(sanitizeTopicName('Research 2024')).toBe('research-2024');
  });

  it('should handle special characters', () => {
    expect(sanitizeTopicName('what*is<this>?')).toBe('what-is-this');
  });

  it('should throw for empty topic', () => {
    expect(() => sanitizeTopicName('')).toThrow('cannot be empty');
  });

  it('should throw for whitespace-only topic', () => {
    expect(() => sanitizeTopicName('   ')).toThrow('cannot be empty');
  });

  it('should generate fallback for all-special-char topics', () => {
    const result = sanitizeTopicName('???');
    expect(result).toMatch(/^research-\d+$/);
  });

  it('should trim whitespace', () => {
    expect(sanitizeTopicName('  hello world  ')).toBe('hello-world');
  });
});

describe('ResearchModeManager', () => {
  let tmpDir: string;
  let manager: ResearchModeManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-mode-test-'));
    manager = new ResearchModeManager({ baseWorkspaceDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getMode / isResearchMode', () => {
    it('should return normal by default', () => {
      expect(manager.getMode('chat-1')).toBe('normal');
      expect(manager.isResearchMode('chat-1')).toBe(false);
    });
  });

  describe('enterResearch', () => {
    it('should enter research mode and create workspace', () => {
      const state = manager.enterResearch('chat-1', 'AI Safety');

      expect(manager.isResearchMode('chat-1')).toBe(true);
      expect(state.topic).toBe('AI Safety');
      expect(state.dirName).toBe('ai-safety');
      expect(state.workspacePath).toContain('research');
      expect(state.workspacePath).toContain('ai-safety');
      expect(state.activatedAt).toBeGreaterThan(0);

      // Verify workspace structure
      expect(fs.existsSync(path.join(state.workspacePath, 'CLAUDE.md'))).toBe(true);
      expect(fs.existsSync(path.join(state.workspacePath, 'RESEARCH.md'))).toBe(true);
      expect(fs.existsSync(path.join(state.workspacePath, 'notes'))).toBe(true);
      expect(fs.existsSync(path.join(state.workspacePath, 'sources'))).toBe(true);
    });

    it('should not overwrite existing CLAUDE.md', () => {
      const state1 = manager.enterResearch('chat-1', 'Test Topic');

      // Write custom content
      const claudeMdPath = path.join(state1.workspacePath, 'CLAUDE.md');
      fs.writeFileSync(claudeMdPath, 'Custom content', 'utf-8');

      // Re-enter should not overwrite
      const state2 = manager.enterResearch('chat-1', 'Test Topic');
      expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe('Custom content');
    });

    it('should not overwrite existing RESEARCH.md', () => {
      const state1 = manager.enterResearch('chat-1', 'Test Topic');

      // Write custom content
      const researchMdPath = path.join(state1.workspacePath, 'RESEARCH.md');
      fs.writeFileSync(researchMdPath, 'Custom research notes', 'utf-8');

      // Re-enter should not overwrite
      manager.enterResearch('chat-1', 'Test Topic');
      expect(fs.readFileSync(researchMdPath, 'utf-8')).toBe('Custom research notes');
    });

    it('should return existing state when re-entering research mode', () => {
      const state1 = manager.enterResearch('chat-1', 'Topic A');
      const state2 = manager.enterResearch('chat-1', 'Topic B');

      // Should return original state, not create new one
      expect(state2.topic).toBe('Topic A');
      expect(state2.workspacePath).toBe(state1.workspacePath);
    });

    it('should create RESEARCH.md with topic and date', () => {
      const state = manager.enterResearch('chat-1', 'Machine Learning');

      const content = fs.readFileSync(
        path.join(state.workspacePath, 'RESEARCH.md'),
        'utf-8'
      );

      expect(content).toContain('Machine Learning');
      expect(content).toContain('In Progress');
    });
  });

  describe('exitResearch', () => {
    it('should exit research mode and return to normal', () => {
      manager.enterResearch('chat-1', 'Test Topic');
      expect(manager.isResearchMode('chat-1')).toBe(true);

      const wasResearch = manager.exitResearch('chat-1');

      expect(wasResearch).toBe(true);
      expect(manager.isResearchMode('chat-1')).toBe(false);
      expect(manager.getResearchState('chat-1')).toBeUndefined();
    });

    it('should preserve workspace directory after exit', () => {
      const state = manager.enterResearch('chat-1', 'Test Topic');
      manager.exitResearch('chat-1');

      // Workspace should still exist
      expect(fs.existsSync(state.workspacePath)).toBe(true);
    });

    it('should return false when not in research mode', () => {
      const wasResearch = manager.exitResearch('chat-1');
      expect(wasResearch).toBe(false);
    });
  });

  describe('getWorkingDirectory', () => {
    it('should return workspace path in research mode', () => {
      const state = manager.enterResearch('chat-1', 'Test Topic');
      expect(manager.getWorkingDirectory('chat-1')).toBe(state.workspacePath);
    });

    it('should return undefined in normal mode', () => {
      expect(manager.getWorkingDirectory('chat-1')).toBeUndefined();
    });

    it('should return undefined after exiting research mode', () => {
      manager.enterResearch('chat-1', 'Test Topic');
      manager.exitResearch('chat-1');
      expect(manager.getWorkingDirectory('chat-1')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all state for a chatId', () => {
      manager.enterResearch('chat-1', 'Test Topic');
      manager.clear('chat-1');

      expect(manager.getMode('chat-1')).toBe('normal');
      expect(manager.getResearchState('chat-1')).toBeUndefined();
    });
  });

  describe('getActiveResearchChats', () => {
    it('should return list of chatIds in research mode', () => {
      manager.enterResearch('chat-1', 'Topic A');
      manager.enterResearch('chat-2', 'Topic B');

      const active = manager.getActiveResearchChats();
      expect(active).toContain('chat-1');
      expect(active).toContain('chat-2');
      expect(active.length).toBe(2);
    });

    it('should not include exited chats', () => {
      manager.enterResearch('chat-1', 'Topic A');
      manager.enterResearch('chat-2', 'Topic B');
      manager.exitResearch('chat-1');

      const active = manager.getActiveResearchChats();
      expect(active).not.toContain('chat-1');
      expect(active).toContain('chat-2');
      expect(active.length).toBe(1);
    });

    it('should return empty array when no research mode active', () => {
      expect(manager.getActiveResearchChats()).toEqual([]);
    });
  });

  describe('per-chatId isolation', () => {
    it('should maintain independent state per chatId', () => {
      const state1 = manager.enterResearch('chat-1', 'Topic A');
      const state2 = manager.enterResearch('chat-2', 'Topic B');

      expect(state1.workspacePath).not.toBe(state2.workspacePath);
      expect(manager.getWorkingDirectory('chat-1')).toBe(state1.workspacePath);
      expect(manager.getWorkingDirectory('chat-2')).toBe(state2.workspacePath);

      manager.exitResearch('chat-1');
      expect(manager.isResearchMode('chat-1')).toBe(false);
      expect(manager.isResearchMode('chat-2')).toBe(true);
    });
  });
});
