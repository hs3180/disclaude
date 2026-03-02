/**
 * Tests for WelcomeService.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { WelcomeService, WELCOME_MESSAGES, GREETING_PATTERNS } from './welcome-service.js';

describe('WelcomeService', () => {
  let service: WelcomeService;
  const testDir = path.join(process.cwd(), 'test-workspace-welcome');

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    service = new WelcomeService({
      workspaceDir: testDir,
      cooldownMs: 1000, // 1 second for testing
    });
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('shouldSendWelcome', () => {
    it('should return true for new chat', () => {
      expect(service.shouldSendWelcome('new-chat-id')).toBe(true);
    });

    it('should return false immediately after sending', () => {
      service.recordWelcomeSent('test-chat');
      expect(service.shouldSendWelcome('test-chat')).toBe(false);
    });

    it('should return true after cooldown period', async () => {
      service.recordWelcomeSent('test-chat');

      // Wait for cooldown (1 second in test)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(service.shouldSendWelcome('test-chat')).toBe(true);
    });

    it('should track multiple chats independently', () => {
      service.recordWelcomeSent('chat-1');
      expect(service.shouldSendWelcome('chat-1')).toBe(false);
      expect(service.shouldSendWelcome('chat-2')).toBe(true);

      service.recordWelcomeSent('chat-2');
      expect(service.shouldSendWelcome('chat-2')).toBe(false);
    });
  });

  describe('recordWelcomeSent', () => {
    it('should record welcome with timestamp', () => {
      service.recordWelcomeSent('test-chat');

      const stats = service.getStats();
      expect(stats.totalChats).toBe(1);
      expect(stats.totalSends).toBe(1);
    });

    it('should increment sent count on repeated sends', async () => {
      service.recordWelcomeSent('test-chat');

      await new Promise((resolve) => setTimeout(resolve, 1100));

      service.recordWelcomeSent('test-chat');

      const stats = service.getStats();
      expect(stats.totalChats).toBe(1);
      expect(stats.totalSends).toBe(2);
    });
  });

  describe('isGreeting', () => {
    it('should recognize Chinese greetings', () => {
      expect(service.isGreeting('你好')).toBe(true);
      expect(service.isGreeting('您好')).toBe(true);
      expect(service.isGreeting('嗨')).toBe(true);
      expect(service.isGreeting('哈喽')).toBe(true);
      expect(service.isGreeting('早上好')).toBe(true);
    });

    it('should recognize English greetings', () => {
      expect(service.isGreeting('hi')).toBe(true);
      expect(service.isGreeting('Hi')).toBe(true);
      expect(service.isGreeting('HI')).toBe(true);
      expect(service.isGreeting('hello')).toBe(true);
      expect(service.isGreeting('Hello')).toBe(true);
      expect(service.isGreeting('hey')).toBe(true);
    });

    it('should handle whitespace', () => {
      expect(service.isGreeting('  你好  ')).toBe(true);
      expect(service.isGreeting('  hi  ')).toBe(true);
    });

    it('should not match non-greetings', () => {
      expect(service.isGreeting('你好吗')).toBe(false);
      expect(service.isGreeting('hello world')).toBe(false);
      expect(service.isGreeting('hi there')).toBe(false);
      expect(service.isGreeting('random text')).toBe(false);
    });
  });

  describe('resetChat', () => {
    it('should reset welcome status for a chat', () => {
      service.recordWelcomeSent('test-chat');
      expect(service.shouldSendWelcome('test-chat')).toBe(false);

      service.resetChat('test-chat');
      expect(service.shouldSendWelcome('test-chat')).toBe(true);
    });
  });

  describe('clearAll', () => {
    it('should clear all welcome records', () => {
      service.recordWelcomeSent('chat-1');
      service.recordWelcomeSent('chat-2');

      service.clearAll();

      expect(service.shouldSendWelcome('chat-1')).toBe(true);
      expect(service.shouldSendWelcome('chat-2')).toBe(true);

      const stats = service.getStats();
      expect(stats.totalChats).toBe(0);
      expect(stats.totalSends).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return empty stats initially', () => {
      const stats = service.getStats();
      expect(stats.totalChats).toBe(0);
      expect(stats.totalSends).toBe(0);
    });

    it('should return correct stats after records', () => {
      service.recordWelcomeSent('chat-1');
      service.recordWelcomeSent('chat-2');
      service.recordWelcomeSent('chat-1'); // Increment count

      const stats = service.getStats();
      expect(stats.totalChats).toBe(2);
      expect(stats.totalSends).toBe(3);
    });
  });

  describe('persistence', () => {
    it('should persist data across instances', () => {
      service.recordWelcomeSent('persistent-chat');

      // Create new service instance with same directory
      const newService = new WelcomeService({
        workspaceDir: testDir,
        cooldownMs: 1000,
      });

      expect(newService.shouldSendWelcome('persistent-chat')).toBe(false);
    });
  });
});

describe('WELCOME_MESSAGES', () => {
  it('should have usage guide', () => {
    expect(WELCOME_MESSAGES.usageGuide).toContain('Agent 助手');
    expect(WELCOME_MESSAGES.usageGuide).toContain('搜索');
  });

  it('should have control commands', () => {
    expect(WELCOME_MESSAGES.controlCommands).toContain('/reset');
    expect(WELCOME_MESSAGES.controlCommands).toContain('/help');
    expect(WELCOME_MESSAGES.controlCommands).toContain('/status');
  });

  it('should have full welcome message', () => {
    expect(WELCOME_MESSAGES.fullWelcome).toContain('Agent 助手');
    expect(WELCOME_MESSAGES.fullWelcome).toContain('/reset');
  });
});

describe('GREETING_PATTERNS', () => {
  it('should have patterns defined', () => {
    expect(GREETING_PATTERNS.length).toBeGreaterThan(0);
  });

  it('should match common greetings', () => {
    const testGreetings = ['你好', 'hi', 'hello', 'hey', '嗨'];
    for (const greeting of testGreetings) {
      const matches = GREETING_PATTERNS.some((p) => p.test(greeting));
      expect(matches).toBe(true);
    }
  });
});
