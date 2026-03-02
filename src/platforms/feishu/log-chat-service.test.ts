import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LogChatService } from './log-chat-service.js';

describe('LogChatService', () => {
  let tempDir: string;
  let service: LogChatService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-chat-test-'));
    service = new LogChatService({ workspaceDir: tempDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getLogChatId', () => {
    it('should return undefined when no log chat is set', async () => {
      const chatId = await service.getLogChatId();
      expect(chatId).toBeUndefined();
    });

    it('should return the log chat ID after setting', async () => {
      await service.setLogChatId('oc_log123', 'Test Log');
      const chatId = await service.getLogChatId();
      expect(chatId).toBe('oc_log123');
    });
  });

  describe('setLogChatId', () => {
    it('should save log chat ID to file', async () => {
      await service.setLogChatId('oc_new_log', 'My Log Chat');

      const filePath = path.join(tempDir, 'log-chat.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      const state = JSON.parse(content);
      expect(state.chatId).toBe('oc_new_log');
      expect(state.topic).toBe('My Log Chat');
      expect(state.createdAt).toBeDefined();
    });

    it('should work without topic', async () => {
      await service.setLogChatId('oc_log_no_topic');

      const chatId = await service.getLogChatId();
      expect(chatId).toBe('oc_log_no_topic');
    });

    it('should create workspace directory if it does not exist', async () => {
      const newDir = path.join(tempDir, 'nested', 'dir');
      const nestedService = new LogChatService({ workspaceDir: newDir });

      await nestedService.setLogChatId('oc_test');
      expect(fs.existsSync(newDir)).toBe(true);
    });
  });

  describe('hasLogChat', () => {
    it('should return false when no log chat is set', async () => {
      const hasLog = await service.hasLogChat();
      expect(hasLog).toBe(false);
    });

    it('should return true after setting log chat', async () => {
      await service.setLogChatId('oc_has_log');
      const hasLog = await service.hasLogChat();
      expect(hasLog).toBe(true);
    });
  });

  describe('clearLogChat', () => {
    it('should clear the log chat configuration', async () => {
      await service.setLogChatId('oc_to_clear');
      await service.clearLogChat();

      const chatId = await service.getLogChatId();
      expect(chatId).toBeUndefined();
    });

    it('should remove the state file', async () => {
      await service.setLogChatId('oc_to_remove');
      await service.clearLogChat();

      const filePath = path.join(tempDir, 'log-chat.json');
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should not throw if no log chat is set', async () => {
      await expect(service.clearLogChat()).resolves.not.toThrow();
    });
  });

  describe('caching', () => {
    it('should cache the state after first load', async () => {
      await service.setLogChatId('oc_cached');

      // First load
      const chatId1 = await service.getLogChatId();
      // Second load should use cache
      const chatId2 = await service.getLogChatId();

      expect(chatId1).toBe(chatId2);
    });
  });
});
