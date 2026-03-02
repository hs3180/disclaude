/**
 * Tests for LogChatService.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LogChatService } from './log-chat-service.js';

describe('LogChatService', () => {
  let tempDir: string;
  let service: LogChatService;

  beforeEach(() => {
    // Create a unique temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-chat-test-'));
    service = new LogChatService({ workspaceDir: tempDir });
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getLogChatId', () => {
    it('returns undefined when no log chat is set', async () => {
      const chatId = await service.getLogChatId();
      expect(chatId).toBeUndefined();
    });

    it('returns the chat ID after setting it', async () => {
      await service.setLogChatId('oc_test123', 'Test Log');
      const chatId = await service.getLogChatId();
      expect(chatId).toBe('oc_test123');
    });
  });

  describe('setLogChatId', () => {
    it('saves the chat ID to file', async () => {
      await service.setLogChatId('oc_test456', 'My Log Chat');

      // Verify file was created
      const statePath = path.join(tempDir, 'log-chat.json');
      expect(fs.existsSync(statePath)).toBe(true);

      // Verify content
      const content = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      expect(content.chatId).toBe('oc_test456');
      expect(content.topic).toBe('My Log Chat');
      expect(content.createdAt).toBeDefined();
    });

    it('updates existing chat ID', async () => {
      await service.setLogChatId('oc_old', 'Old');
      await service.setLogChatId('oc_new', 'New');

      const chatId = await service.getLogChatId();
      expect(chatId).toBe('oc_new');
    });
  });

  describe('hasLogChat', () => {
    it('returns false when no log chat is set', async () => {
      const hasLogChat = await service.hasLogChat();
      expect(hasLogChat).toBe(false);
    });

    it('returns true after setting log chat', async () => {
      await service.setLogChatId('oc_test');
      const hasLogChat = await service.hasLogChat();
      expect(hasLogChat).toBe(true);
    });
  });

  describe('clearLogChat', () => {
    it('removes the log chat configuration', async () => {
      await service.setLogChatId('oc_test');
      await service.clearLogChat();

      const chatId = await service.getLogChatId();
      expect(chatId).toBeUndefined();
    });

    it('does not throw when no log chat is set', async () => {
      await expect(service.clearLogChat()).resolves.not.toThrow();
    });
  });

  describe('caching', () => {
    it('caches the state after first load', async () => {
      await service.setLogChatId('oc_cached');

      // First load (from file)
      const chatId1 = await service.getLogChatId();
      expect(chatId1).toBe('oc_cached');

      // Modify file directly
      const statePath = path.join(tempDir, 'log-chat.json');
      fs.writeFileSync(statePath, JSON.stringify({ chatId: 'oc_modified', createdAt: new Date().toISOString() }));

      // Should still return cached value
      const chatId2 = await service.getLogChatId();
      expect(chatId2).toBe('oc_cached');
    });

    it('updates cache when setting new chat ID', async () => {
      await service.setLogChatId('oc_first');
      await service.setLogChatId('oc_second');

      const chatId = await service.getLogChatId();
      expect(chatId).toBe('oc_second');
    });
  });

  describe('workspace directory creation', () => {
    it('creates workspace directory if it does not exist', async () => {
      const nestedDir = path.join(tempDir, 'nested', 'dir');
      const nestedService = new LogChatService({ workspaceDir: nestedDir });

      await nestedService.setLogChatId('oc_test');

      expect(fs.existsSync(nestedDir)).toBe(true);
    });
  });
});
