/**
 * Tests for LogChatService.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LogChatService, resetLogChatService } from './log-chat-service.js';

describe('LogChatService', () => {
  let tempDir: string;
  let service: LogChatService;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-chat-test-'));
    resetLogChatService();
    service = new LogChatService(tempDir);
  });

  afterEach(() => {
    // Clean up temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetLogChatService();
  });

  describe('initialization', () => {
    it('should start with no configuration', async () => {
      await service.init();
      const config = await service.getConfig();
      expect(config).toBeNull();
    });

    it('should load existing configuration', async () => {
      // Write a config file
      const existingConfig = {
        chatId: 'oc_test123',
        topic: 'Test Log',
        setAt: '2026-01-01T00:00:00.000Z',
        setBy: 'ou_user1',
      };
      fs.writeFileSync(
        path.join(tempDir, 'log-chat.json'),
        JSON.stringify(existingConfig)
      );

      // Create new service instance to load existing config
      resetLogChatService();
      const newService = new LogChatService(tempDir);
      const config = await newService.getConfig();

      expect(config).toEqual(existingConfig);
    });
  });

  describe('setLogChat', () => {
    it('should set log chat with required parameters', async () => {
      const message = await service.setLogChat('oc_test123');

      expect(message).toContain('✅');
      expect(message).toContain('oc_test123');
      expect(message).toContain('调试日志');

      const config = await service.getConfig();
      expect(config).not.toBeNull();
      expect(config!.chatId).toBe('oc_test123');
      expect(config!.topic).toBe('调试日志');
    });

    it('should set log chat with custom topic', async () => {
      const message = await service.setLogChat('oc_test456', 'Custom Topic');

      expect(message).toContain('Custom Topic');

      const config = await service.getConfig();
      expect(config!.topic).toBe('Custom Topic');
    });

    it('should set log chat with setBy', async () => {
      await service.setLogChat('oc_test789', 'Topic', 'ou_user1');

      const config = await service.getConfig();
      expect(config!.setBy).toBe('ou_user1');
    });

    it('should persist configuration to file', async () => {
      await service.setLogChat('oc_persist', 'Persistent');

      const configPath = path.join(tempDir, 'log-chat.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(saved.chatId).toBe('oc_persist');
      expect(saved.topic).toBe('Persistent');
    });

    it('should overwrite existing configuration', async () => {
      await service.setLogChat('oc_first', 'First');
      await service.setLogChat('oc_second', 'Second');

      const config = await service.getConfig();
      expect(config!.chatId).toBe('oc_second');
      expect(config!.topic).toBe('Second');
    });
  });

  describe('clearLogChat', () => {
    it('should clear existing configuration', async () => {
      await service.setLogChat('oc_to_clear', 'To Clear');
      const message = await service.clearLogChat();

      expect(message).toContain('✅');
      expect(message).toContain('oc_to_clear');

      const config = await service.getConfig();
      expect(config).toBeNull();
    });

    it('should return message when no configuration exists', async () => {
      const message = await service.clearLogChat();

      expect(message).toContain('⚠️');
      expect(message).toContain('未设置');
    });

    it('should remove config file', async () => {
      await service.setLogChat('oc_to_remove', 'To Remove');

      const configPath = path.join(tempDir, 'log-chat.json');
      expect(fs.existsSync(configPath)).toBe(true);

      await service.clearLogChat();
      expect(fs.existsSync(configPath)).toBe(false);
    });
  });

  describe('showLogChat', () => {
    it('should show current configuration', async () => {
      await service.setLogChat('oc_show_test', 'Show Test');
      const message = await service.showLogChat();

      expect(message).toContain('📋');
      expect(message).toContain('oc_show_test');
      expect(message).toContain('Show Test');
      expect(message).toContain('✅ 已设置');
    });

    it('should indicate when no configuration exists', async () => {
      const message = await service.showLogChat();

      expect(message).toContain('📋');
      expect(message).toContain('未设置');
    });

    it('should include setBy if available', async () => {
      await service.setLogChat('oc_with_user', 'With User', 'ou_testuser');
      const message = await service.showLogChat();

      expect(message).toContain('ou_testuser');
    });
  });

  describe('getLogChatId', () => {
    it('should return chat ID when configured', async () => {
      await service.setLogChat('oc_get_id', 'Get ID');
      const chatId = await service.getLogChatId();

      expect(chatId).toBe('oc_get_id');
    });

    it('should return null when not configured', async () => {
      const chatId = await service.getLogChatId();

      expect(chatId).toBeNull();
    });
  });

  describe('hasLogChat', () => {
    it('should return true when configured', async () => {
      await service.setLogChat('oc_has', 'Has');
      const has = await service.hasLogChat();

      expect(has).toBe(true);
    });

    it('should return false when not configured', async () => {
      const has = await service.hasLogChat();

      expect(has).toBe(false);
    });
  });

  describe('persistence', () => {
    it('should persist across service instances', async () => {
      await service.setLogChat('oc_persist_test', 'Persist Test');

      // Create a new service instance
      resetLogChatService();
      const newService = new LogChatService(tempDir);
      const config = await newService.getConfig();

      expect(config).not.toBeNull();
      expect(config!.chatId).toBe('oc_persist_test');
      expect(config!.topic).toBe('Persist Test');
    });
  });
});
