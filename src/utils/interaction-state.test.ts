/**
 * Tests for Interaction State Storage.
 *
 * @module utils/interaction-state.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  initInteractionState,
  registerInteractionContext,
  getInteractionContext,
  getActionPrompts,
  unregisterInteractionContext,
  cleanupExpiredContexts,
  getContextCount,
  clearAllContexts,
} from './interaction-state.js';
import type { ActionPromptMap } from '../mcp/tools/types.js';

describe('Interaction State Storage', () => {
  let tempDir: string;
  let testFilePath: string;

  beforeEach(() => {
    // Create a temp file for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-state-test-'));
    testFilePath = path.join(tempDir, 'interactions.json');

    // Initialize with test file path
    initInteractionState({ filePath: testFilePath });
    clearAllContexts();
  });

  afterEach(() => {
    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('registerInteractionContext', () => {
    it('should register a new context', () => {
      const actionPrompts: ActionPromptMap = {
        confirm: 'User confirmed',
        cancel: 'User cancelled',
      };

      registerInteractionContext('msg-1', 'chat-1', actionPrompts);

      expect(getContextCount()).toBe(1);
      const context = getInteractionContext('msg-1');
      expect(context).toBeDefined();
      expect(context?.chatId).toBe('chat-1');
      expect(context?.actionPrompts).toEqual(actionPrompts);
    });

    it('should persist context to file', () => {
      const actionPrompts: ActionPromptMap = {
        action1: 'Prompt 1',
      };

      registerInteractionContext('msg-2', 'chat-2', actionPrompts);

      // Verify file was created
      expect(fs.existsSync(testFilePath)).toBe(true);

      // Read file and verify content
      const content = fs.readFileSync(testFilePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.contexts['msg-2']).toBeDefined();
      expect(data.contexts['msg-2'].actionPrompts).toEqual(actionPrompts);
    });

    it('should update existing context', () => {
      const prompts1: ActionPromptMap = { action1: 'Prompt 1' };
      const prompts2: ActionPromptMap = { action1: 'Updated Prompt 1', action2: 'Prompt 2' };

      registerInteractionContext('msg-3', 'chat-3', prompts1);
      registerInteractionContext('msg-3', 'chat-3', prompts2);

      const context = getInteractionContext('msg-3');
      expect(context?.actionPrompts).toEqual(prompts2);
    });
  });

  describe('getInteractionContext', () => {
    it('should return undefined for non-existent context', () => {
      const context = getInteractionContext('non-existent');
      expect(context).toBeUndefined();
    });

    it('should return registered context', () => {
      const actionPrompts: ActionPromptMap = { test: 'Test prompt' };
      registerInteractionContext('msg-4', 'chat-4', actionPrompts);

      const context = getInteractionContext('msg-4');
      expect(context).toBeDefined();
      expect(context?.messageId).toBe('msg-4');
      expect(context?.chatId).toBe('chat-4');
    });

    it('should load context from file if not in memory', () => {
      const actionPrompts: ActionPromptMap = { file: 'File prompt' };
      registerInteractionContext('msg-5', 'chat-5', actionPrompts);

      // Re-initialize to clear memory cache but keep file
      initInteractionState({ filePath: testFilePath });

      // Context should still be available from file
      const context = getInteractionContext('msg-5');
      expect(context).toBeDefined();
      expect(context?.actionPrompts).toEqual(actionPrompts);
    });
  });

  describe('getActionPrompts', () => {
    it('should return action prompts for a message', () => {
      const actionPrompts: ActionPromptMap = {
        yes: 'User said yes',
        no: 'User said no',
      };
      registerInteractionContext('msg-6', 'chat-6', actionPrompts);

      const prompts = getActionPrompts('msg-6');
      expect(prompts).toEqual(actionPrompts);
    });

    it('should return undefined for non-existent message', () => {
      const prompts = getActionPrompts('non-existent');
      expect(prompts).toBeUndefined();
    });
  });

  describe('unregisterInteractionContext', () => {
    it('should remove registered context', () => {
      registerInteractionContext('msg-7', 'chat-7', { action: 'Prompt' });

      const result = unregisterInteractionContext('msg-7');

      expect(result).toBe(true);
      expect(getInteractionContext('msg-7')).toBeUndefined();
    });

    it('should return false for non-existent context', () => {
      const result = unregisterInteractionContext('non-existent');
      expect(result).toBe(false);
    });

    it('should update file after removal', () => {
      registerInteractionContext('msg-8', 'chat-8', { action: 'Prompt' });
      unregisterInteractionContext('msg-8');

      const content = fs.readFileSync(testFilePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.contexts['msg-8']).toBeUndefined();
    });
  });

  describe('cleanupExpiredContexts', () => {
    it('should remove expired contexts', () => {
      // Create an expired context manually
      const expiredContext = {
        messageId: 'msg-expired',
        chatId: 'chat-expired',
        actionPrompts: { action: 'Expired' },
        createdAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      };

      // Write directly to file and reload
      const storage = {
        version: 1,
        contexts: {
          'msg-expired': expiredContext,
          'msg-valid': {
            messageId: 'msg-valid',
            chatId: 'chat-valid',
            actionPrompts: { action: 'Valid' },
            createdAt: Date.now(),
          },
        },
      };
      fs.writeFileSync(testFilePath, JSON.stringify(storage));
      initInteractionState({ filePath: testFilePath });

      const cleaned = cleanupExpiredContexts();

      expect(cleaned).toBe(1);
      expect(getInteractionContext('msg-expired')).toBeUndefined();
      expect(getInteractionContext('msg-valid')).toBeDefined();
    });

    it('should return 0 when nothing to clean', () => {
      registerInteractionContext('msg-recent', 'chat-recent', { action: 'Recent' });

      const cleaned = cleanupExpiredContexts();
      expect(cleaned).toBe(0);
    });
  });

  describe('getContextCount', () => {
    it('should return correct count', () => {
      expect(getContextCount()).toBe(0);

      registerInteractionContext('msg-a', 'chat-a', { action: 'A' });
      expect(getContextCount()).toBe(1);

      registerInteractionContext('msg-b', 'chat-b', { action: 'B' });
      expect(getContextCount()).toBe(2);
    });
  });

  describe('clearAllContexts', () => {
    it('should remove all contexts', () => {
      registerInteractionContext('msg-1', 'chat-1', { action: '1' });
      registerInteractionContext('msg-2', 'chat-2', { action: '2' });

      clearAllContexts();

      expect(getContextCount()).toBe(0);
      expect(getInteractionContext('msg-1')).toBeUndefined();
      expect(getInteractionContext('msg-2')).toBeUndefined();
    });
  });

  describe('cross-process simulation', () => {
    it('should support reading context written by another "process"', () => {
      // Simulate process A writing
      const actionPrompts: ActionPromptMap = { cross: 'Cross-process prompt' };

      // Write directly to file (simulating another process)
      const storage = {
        version: 1,
        contexts: {
          'msg-cross': {
            messageId: 'msg-cross',
            chatId: 'chat-cross',
            actionPrompts,
            createdAt: Date.now(),
          },
        },
      };
      fs.writeFileSync(testFilePath, JSON.stringify(storage));

      // Simulate process B reading (clear memory first)
      initInteractionState({ filePath: testFilePath });

      // Should be able to read the context
      const context = getInteractionContext('msg-cross');
      expect(context).toBeDefined();
      expect(context?.actionPrompts).toEqual(actionPrompts);
    });
  });
});
