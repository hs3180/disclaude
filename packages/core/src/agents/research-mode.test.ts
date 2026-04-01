/**
 * ResearchModeManager unit tests.
 *
 * Issue #1709 - Research Mode Phase 1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ResearchModeManager } from './research-mode.js';

describe('ResearchModeManager', () => {
  let manager: ResearchModeManager;
  let tempDir: string;

  beforeEach(async () => {
    manager = new ResearchModeManager();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-mode-test-'));
  });

  afterEach(async () => {
    manager.clearAll();
    // Clean up temp dir
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('getState / getMode', () => {
    it('should return normal mode by default', () => {
      const state = manager.getState('chat-1');
      expect(state.mode).toBe('normal');
      expect(state.topic).toBeUndefined();
      expect(state.researchDir).toBeUndefined();
    });

    it('should return consistent state for same chatId', () => {
      const state1 = manager.getState('chat-1');
      const state2 = manager.getState('chat-1');
      expect(state1).toBe(state2); // Same reference
    });

    it('should return independent states for different chatIds', () => {
      const state1 = manager.getState('chat-1');
      const state2 = manager.getState('chat-2');
      expect(state1).not.toBe(state2);
    });

    it('should return correct mode via getMode()', () => {
      expect(manager.getMode('chat-1')).toBe('normal');
    });
  });

  describe('isResearchMode', () => {
    it('should return false by default', () => {
      expect(manager.isResearchMode('chat-1')).toBe(false);
    });
  });

  describe('getResearchDir', () => {
    it('should return undefined when not in research mode', () => {
      expect(manager.getResearchDir('chat-1')).toBeUndefined();
    });
  });

  describe('clearState / clearAll', () => {
    it('should clear state for a specific chatId', () => {
      manager.getState('chat-1');
      manager.clearState('chat-1');
      // After clearing, getState should create a new state
      const newState = manager.getState('chat-1');
      expect(newState.mode).toBe('normal');
    });

    it('should clear all states', () => {
      manager.getState('chat-1');
      manager.getState('chat-2');
      manager.getState('chat-3');
      manager.clearAll();
      expect(manager.getMode('chat-1')).toBe('normal');
      expect(manager.getMode('chat-2')).toBe('normal');
      expect(manager.getMode('chat-3')).toBe('normal');
    });
  });

  describe('enterResearch', () => {
    it('should throw when topic is empty', async () => {
      await expect(manager.enterResearch('chat-1', '')).rejects.toThrow('Research topic is required');
      await expect(manager.enterResearch('chat-1', '   ')).rejects.toThrow('Research topic is required');
      await expect(manager.enterResearch('chat-1', '  ')).rejects.toThrow('Research topic is required');
    });

    it('should throw when already in research mode', async () => {
      // Note: enterResearch creates actual directories, so we need to handle that.
      // Since we can't easily mock Config.getResearchDir, we'll test the error path.
      // This test verifies the mode check happens before directory creation.

      // Manually set to research mode to test the guard
      const state = manager.getState('chat-1');
      state.mode = 'research';
      state.topic = 'existing-topic';
      state.researchDir = '/some/path';

      await expect(
        manager.enterResearch('chat-1', 'new-topic')
      ).rejects.toThrow('Already in research mode');
    });

    it('should sanitize topic name (replace slashes and special chars)', async () => {
      // The topic '../etc/passwd' should be sanitized to '..-etc-passwd'
      const result = await manager.enterResearch('chat-1', '../etc/passwd');
      expect(result.researchDir).toContain('..-etc-passwd');
      expect(result.researchDir).not.toContain('../');
      // Clean up
      await fs.rm(result.researchDir, { recursive: true, force: true }).catch(() => {});
      manager.exitResearch('chat-1');
    });

    it('should limit topic length to 100 characters', async () => {
      const longTopic = 'a'.repeat(200);
      const result = await manager.enterResearch('chat-1', longTopic);
      // The topic should be truncated to 100 chars
      expect(result.researchDir).toMatch(/a{100}$/);
      // Clean up
      await fs.rm(result.researchDir, { recursive: true, force: true }).catch(() => {});
      manager.exitResearch('chat-1');
    });
  });

  describe('exitResearch', () => {
    it('should return null when not in research mode', () => {
      const result = manager.exitResearch('chat-1');
      expect(result).toBeNull();
    });

    it('should exit research mode and return previous state', () => {
      const state = manager.getState('chat-1');
      state.mode = 'research';
      state.topic = 'test-topic';
      state.researchDir = '/workspace/research/test-topic';
      state.activatedAt = Date.now();

      const result = manager.exitResearch('chat-1');

      expect(result).toEqual({
        topic: 'test-topic',
        researchDir: '/workspace/research/test-topic',
      });

      // Verify state is reset
      expect(manager.getMode('chat-1')).toBe('normal');
      expect(manager.getResearchDir('chat-1')).toBeUndefined();
    });
  });

  describe('getActiveResearchSessions', () => {
    it('should return empty array when no sessions are in research mode', () => {
      expect(manager.getActiveResearchSessions()).toEqual([]);
    });

    it('should return only research mode sessions', () => {
      // Set up chat-1 in research mode
      const state1 = manager.getState('chat-1');
      state1.mode = 'research';
      state1.topic = 'topic-1';
      state1.researchDir = '/workspace/research/topic-1';

      // Set up chat-2 in normal mode
      manager.getState('chat-2');

      // Set up chat-3 in research mode
      const state3 = manager.getState('chat-3');
      state3.mode = 'research';
      state3.topic = 'topic-2';
      state3.researchDir = '/workspace/research/topic-2';

      const sessions = manager.getActiveResearchSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].chatId).toBe('chat-1');
      expect(sessions[0].topic).toBe('topic-1');
      expect(sessions[1].chatId).toBe('chat-3');
      expect(sessions[1].topic).toBe('topic-2');
    });
  });

  describe('ResearchModeState type', () => {
    it('should track activatedAt timestamp', () => {
      const state = manager.getState('chat-1');
      state.mode = 'research';
      state.topic = 'test';
      state.researchDir = '/test';
      state.activatedAt = 1234567890;

      const retrieved = manager.getState('chat-1');
      expect(retrieved.activatedAt).toBe(1234567890);
    });
  });
});
