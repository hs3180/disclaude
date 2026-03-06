/**
 * Tests for interaction-state module.
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

describe('InteractionState', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    // Create a temp file for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-state-test-'));
    tempFile = path.join(tempDir, 'interactions.json');

    // Initialize with temp file
    initInteractionState({ filePath: tempFile });
    clearAllContexts();
  });

  afterEach(() => {
    // Cleanup temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('registerInteractionContext', () => {
    it('should register a new context', () => {
      const actionPrompts: ActionPromptMap = { confirm: 'Confirmed!', cancel: 'Cancelled!' };
      registerInteractionContext('msg-1', 'chat-1', actionPrompts);

      expect(getContextCount()).toBe(1);
      const context = getInteractionContext('msg-1');
      expect(context).toBeDefined();
      expect(context?.chatId).toBe('chat-1');
      expect(context?.actionPrompts).toEqual(actionPrompts);
    });

    it('should persist context to file', () => {
      const actionPrompts: ActionPromptMap = { ok: 'OK' };
      registerInteractionContext('msg-2', 'chat-2', actionPrompts);

      // Verify file exists and contains the context
      expect(fs.existsSync(tempFile)).toBe(true);
      const content = fs.readFileSync(tempFile, 'utf-8');
      const data = JSON.parse(content);
      expect(data.contexts['msg-2']).toBeDefined();
      expect(data.contexts['msg-2'].chatId).toBe('chat-2');
    });

    it('should overwrite existing context with same messageId', () => {
      registerInteractionContext('msg-3', 'chat-1', { action: 'First' });
      registerInteractionContext('msg-3', 'chat-2', { action: 'Second' });

      const context = getInteractionContext('msg-3');
      expect(context?.chatId).toBe('chat-2');
      expect(context?.actionPrompts.action).toBe('Second');
      expect(getContextCount()).toBe(1);
    });
  });

  describe('getInteractionContext', () => {
    it('should return undefined for non-existent context', () => {
      const context = getInteractionContext('non-existent');
      expect(context).toBeUndefined();
    });

    it('should return context from memory cache', () => {
      registerInteractionContext('msg-4', 'chat-1', { test: 'value' });
      const context = getInteractionContext('msg-4');
      expect(context?.actionPrompts.test).toBe('value');
    });

    it('should load context from file if not in memory cache', () => {
      // Register and save to file
      registerInteractionContext('msg-5', 'chat-1', { file: 'loaded' });

      // Clear memory cache by reinitializing
      initInteractionState({ filePath: tempFile });

      // Should load from file
      const context = getInteractionContext('msg-5');
      expect(context?.actionPrompts.file).toBe('loaded');
    });
  });

  describe('getActionPrompts', () => {
    it('should return action prompts for a message', () => {
      const actionPrompts: ActionPromptMap = {
        confirm: 'You confirmed',
        deny: 'You denied',
      };
      registerInteractionContext('msg-6', 'chat-1', actionPrompts);

      const prompts = getActionPrompts('msg-6');
      expect(prompts).toEqual(actionPrompts);
    });

    it('should return undefined for non-existent message', () => {
      const prompts = getActionPrompts('non-existent');
      expect(prompts).toBeUndefined();
    });
  });

  describe('unregisterInteractionContext', () => {
    it('should remove an existing context', () => {
      registerInteractionContext('msg-7', 'chat-1', { action: 'test' });
      expect(getContextCount()).toBe(1);

      const removed = unregisterInteractionContext('msg-7');
      expect(removed).toBe(true);
      expect(getContextCount()).toBe(0);
      expect(getInteractionContext('msg-7')).toBeUndefined();
    });

    it('should return false for non-existent context', () => {
      const removed = unregisterInteractionContext('non-existent');
      expect(removed).toBe(false);
    });

    it('should persist removal to file', () => {
      registerInteractionContext('msg-8', 'chat-1', { action: 'test' });
      unregisterInteractionContext('msg-8');

      // Verify file is updated
      const content = fs.readFileSync(tempFile, 'utf-8');
      const data = JSON.parse(content);
      expect(data.contexts['msg-8']).toBeUndefined();
    });
  });

  describe('cleanupExpiredContexts', () => {
    it('should remove contexts older than 24 hours', () => {
      // Create a context with old timestamp
      const oldContext = {
        messageId: 'msg-old',
        chatId: 'chat-1',
        actionPrompts: { action: 'old' },
        createdAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      };

      // Manually write old context to file
      const storage = { version: 1, contexts: { 'msg-old': oldContext } };
      fs.writeFileSync(tempFile, JSON.stringify(storage));

      // Reinitialize to load old context
      initInteractionState({ filePath: tempFile });

      // Add a fresh context
      registerInteractionContext('msg-fresh', 'chat-1', { action: 'fresh' });

      expect(getContextCount()).toBe(2);

      const cleaned = cleanupExpiredContexts();
      expect(cleaned).toBe(1);
      expect(getContextCount()).toBe(1);
      expect(getInteractionContext('msg-old')).toBeUndefined();
      expect(getInteractionContext('msg-fresh')).toBeDefined();
    });

    it('should return 0 when nothing to clean', () => {
      registerInteractionContext('msg-fresh', 'chat-1', { action: 'test' });
      const cleaned = cleanupExpiredContexts();
      expect(cleaned).toBe(0);
    });
  });

  describe('getContextCount', () => {
    it('should return correct count', () => {
      expect(getContextCount()).toBe(0);

      registerInteractionContext('msg-a', 'chat-1', { a: '1' });
      expect(getContextCount()).toBe(1);

      registerInteractionContext('msg-b', 'chat-1', { b: '2' });
      expect(getContextCount()).toBe(2);

      unregisterInteractionContext('msg-a');
      expect(getContextCount()).toBe(1);
    });
  });

  describe('clearAllContexts', () => {
    it('should remove all contexts', () => {
      registerInteractionContext('msg-1', 'chat-1', { a: '1' });
      registerInteractionContext('msg-2', 'chat-1', { b: '2' });
      registerInteractionContext('msg-3', 'chat-1', { c: '3' });

      expect(getContextCount()).toBe(3);

      clearAllContexts();

      expect(getContextCount()).toBe(0);
      expect(getInteractionContext('msg-1')).toBeUndefined();
      expect(getInteractionContext('msg-2')).toBeUndefined();
      expect(getInteractionContext('msg-3')).toBeUndefined();
    });

    it('should persist cleared state to file', () => {
      registerInteractionContext('msg-1', 'chat-1', { a: '1' });
      clearAllContexts();

      const content = fs.readFileSync(tempFile, 'utf-8');
      const data = JSON.parse(content);
      expect(Object.keys(data.contexts)).toHaveLength(0);
    });
  });

  describe('cross-process simulation', () => {
    it('should allow reading contexts written by another "process"', () => {
      // Simulate process A writing
      registerInteractionContext('msg-shared', 'chat-1', { shared: 'data' });

      // Simulate process B reading by reinitializing
      initInteractionState({ filePath: tempFile });

      const context = getInteractionContext('msg-shared');
      expect(context?.actionPrompts.shared).toBe('data');
    });
  });
});
