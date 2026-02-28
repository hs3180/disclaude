/**
 * Tests for BackgroundAnalyzer.
 *
 * @see Issue #357 - Intelligent Scheduled Task Recommendation System
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { BackgroundAnalyzer } from './background-analyzer.js';
import { PatternStore } from './pattern-store.js';
import type { BackgroundAnalyzerConfig, ChatAnalysisResult } from './types.js';

// Mock the message logger
const mockMessageLogger = {
  getChatHistory: vi.fn(),
  logIncomingMessage: vi.fn(),
  logOutgoingMessage: vi.fn(),
  isMessageProcessed: vi.fn(),
  init: vi.fn(),
  clearCache: vi.fn(),
};

describe('BackgroundAnalyzer', () => {
  let analyzer: BackgroundAnalyzer;
  let patternStore: PatternStore;
  let testDir: string;
  let chatDir: string;
  let config: BackgroundAnalyzerConfig;

  beforeEach(async () => {
    // Create test directories
    testDir = path.join('/tmp', `background-analyzer-test-${Date.now()}`);
    chatDir = path.join(testDir, 'chat');
    await fs.mkdir(chatDir, { recursive: true });

    // Create pattern store
    patternStore = new PatternStore({ dataDir: path.join(testDir, 'analysis') });
    await patternStore.init();

    // Config with analysis disabled (we'll run manually)
    config = {
      enabled: false,
      analysisInterval: '0 3 * * *',
      lookbackDays: 30,
      minOccurrences: 3,
      minConfidence: 0.7,
    };
  });

  afterEach(async () => {
    // Clean up
    if (analyzer) {
      analyzer.stop();
    }
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create analyzer with config', () => {
      // Mock Config.getWorkspaceDir for this test
      vi.doMock('../config/index.js', () => ({
        Config: {
          getWorkspaceDir: () => testDir,
        },
      }));

      analyzer = new BackgroundAnalyzer({
        config,
        patternStore,
        messageLogger: mockMessageLogger as any,
      });

      expect(analyzer).toBeDefined();
      expect(analyzer.isRunning()).toBe(false);
    });
  });

  describe('start/stop', () => {
    it('should not start when disabled', async () => {
      analyzer = new BackgroundAnalyzer({
        config: { ...config, enabled: false },
        patternStore,
        messageLogger: mockMessageLogger as any,
      });

      // Override chatDir for testing
      (analyzer as any).chatDir = chatDir;

      await analyzer.start();
      expect(analyzer.isRunning()).toBe(false);
    });

    it('should start when enabled', async () => {
      analyzer = new BackgroundAnalyzer({
        config: { ...config, enabled: true },
        patternStore,
        messageLogger: mockMessageLogger as any,
      });

      // Override chatDir for testing
      (analyzer as any).chatDir = chatDir;

      await analyzer.start();
      expect(analyzer.isRunning()).toBe(true);

      analyzer.stop();
      expect(analyzer.isRunning()).toBe(false);
    });

    it('should not start twice', async () => {
      analyzer = new BackgroundAnalyzer({
        config: { ...config, enabled: true },
        patternStore,
        messageLogger: mockMessageLogger as any,
      });

      // Override chatDir for testing
      (analyzer as any).chatDir = chatDir;

      await analyzer.start();
      await analyzer.start(); // Should not throw

      expect(analyzer.isRunning()).toBe(true);
      analyzer.stop();
    });
  });

  describe('runAnalysisNow', () => {
    it('should return empty result when no chat files exist', async () => {
      analyzer = new BackgroundAnalyzer({
        config,
        patternStore,
        messageLogger: mockMessageLogger as any,
      });

      // Override chatDir for testing
      (analyzer as any).chatDir = chatDir;

      const result = await analyzer.runAnalysisNow();

      expect(result.chats).toHaveLength(0);
      expect(result.summary.totalChats).toBe(0);
      expect(result.summary.totalPatterns).toBe(0);
    });

    it('should analyze chat file and detect patterns', async () => {
      // Create a test chat file with multiple issue-related messages
      const chatId = 'oc_test_chat';
      const chatFile = path.join(chatDir, `${chatId}.md`);
      const now = new Date();

      // Create messages spread over multiple days - use keywords that match taskKeywords
      // Use 10 messages to ensure occurrenceScore >= 1.0 for high confidence
      const messages = [];
      for (let i = 0; i < 10; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const timestamp = date.toISOString();
        messages.push(`
## [${timestamp}] 📥 User (message_id: msg-${i})

**Sender**: ou_test_user
**Type**: text

查看 GitHub issue 列表

---

`);
      }

      const chatContent = `# Chat Message Log: ${chatId}

**Chat ID**: ${chatId}
**Created**: ${now.toISOString()}
**Last Updated**: ${now.toISOString()}

---

${messages.join('')}
`;

      await fs.writeFile(chatFile, chatContent, 'utf-8');

      analyzer = new BackgroundAnalyzer({
        config: { ...config, minOccurrences: 3, minConfidence: 0.5 },
        patternStore,
        messageLogger: mockMessageLogger as any,
      });

      // Override chatDir for testing
      (analyzer as any).chatDir = chatDir;

      const result = await analyzer.runAnalysisNow();

      expect(result.chats).toHaveLength(1);
      expect(result.summary.totalPatterns).toBeGreaterThan(0);
    });

    it('should call onPatternsDetected callback when patterns found', async () => {
      const onPatternsDetected = vi.fn();

      // Create a test chat file
      const chatId = 'oc_test_callback';
      const chatFile = path.join(chatDir, `${chatId}.md`);
      const now = new Date();

      // Use 10 messages for high confidence
      const messages = [];
      for (let i = 0; i < 10; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const timestamp = date.toISOString();
        messages.push(`
## [${timestamp}] 📥 User (message_id: msg-${i})

**Sender**: ou_test_user
**Type**: text

查看 issue 列表

---

`);
      }

      const chatContent = `# Chat Message Log: ${chatId}

**Chat ID**: ${chatId}
**Created**: ${now.toISOString()}
**Last Updated**: ${now.toISOString()}

---

${messages.join('')}
`;

      await fs.writeFile(chatFile, chatContent, 'utf-8');

      analyzer = new BackgroundAnalyzer({
        config: { ...config, minOccurrences: 3, minConfidence: 0.5 },
        patternStore,
        messageLogger: mockMessageLogger as any,
        onPatternsDetected,
      });

      // Override chatDir for testing
      (analyzer as any).chatDir = chatDir;

      await analyzer.runAnalysisNow();

      // Should have called the callback
      expect(onPatternsDetected).toHaveBeenCalled();
    });
  });

  describe('pattern detection', () => {
    it('should detect weekly patterns', async () => {
      const chatId = 'oc_weekly_pattern';
      const chatFile = path.join(chatDir, `${chatId}.md`);
      const now = new Date();

      // Create messages on same day of week (Fridays) - 10 messages for high confidence
      const messages = [];
      for (let i = 0; i < 10; i++) {
        const date = new Date(now);
        // Go back i weeks
        date.setDate(date.getDate() - (i * 7));
        // Make it a Friday (day 5)
        date.setDate(date.getDate() - date.getDay() + 5);
        const timestamp = date.toISOString();
        messages.push(`
## [${timestamp}] 📥 User (message_id: msg-${i})

**Sender**: ou_test_user
**Type**: text

生成报告和工作总结

---

`);
      }

      const chatContent = `# Chat Message Log: ${chatId}

**Chat ID**: ${chatId}
**Created**: ${now.toISOString()}
**Last Updated**: ${now.toISOString()}

---

${messages.join('')}
`;

      await fs.writeFile(chatFile, chatContent, 'utf-8');

      analyzer = new BackgroundAnalyzer({
        config: { ...config, minOccurrences: 3, minConfidence: 0.5 },
        patternStore,
        messageLogger: mockMessageLogger as any,
      });

      // Override chatDir for testing
      (analyzer as any).chatDir = chatDir;

      const result = await analyzer.runAnalysisNow();

      expect(result.chats).toHaveLength(1);
      // Should detect report-generation pattern
      expect(result.summary.totalPatterns).toBeGreaterThan(0);
    });

    it('should not detect patterns with insufficient occurrences', async () => {
      const chatId = 'oc_insufficient';
      const chatFile = path.join(chatDir, `${chatId}.md`);
      const now = new Date();

      // Only 2 messages (below minOccurrences of 3)
      const messages = [];
      for (let i = 0; i < 2; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const timestamp = date.toISOString();
        messages.push(`
## [${timestamp}] 📥 User (message_id: msg-${i})

**Sender**: ou_test_user
**Type**: text

查看 issue

---

`);
      }

      const chatContent = `# Chat Message Log: ${chatId}

**Chat ID**: ${chatId}
**Created**: ${now.toISOString()}
**Last Updated**: ${now.toISOString()}

---

${messages.join('')}
`;

      await fs.writeFile(chatFile, chatContent, 'utf-8');

      analyzer = new BackgroundAnalyzer({
        config: { ...config, minOccurrences: 3 },
        patternStore,
        messageLogger: mockMessageLogger as any,
      });

      // Override chatDir for testing
      (analyzer as any).chatDir = chatDir;

      const result = await analyzer.runAnalysisNow();

      expect(result.chats).toHaveLength(1);
      // Should not detect any patterns
      expect(result.summary.totalPatterns).toBe(0);
    });
  });

  describe('config options', () => {
    it('should respect lookbackDays config', async () => {
      const chatId = 'oc_lookback';
      const chatFile = path.join(chatDir, `${chatId}.md`);
      const now = new Date();

      // Create messages older than lookback period (60 days ago)
      const messages = [];
      for (let i = 0; i < 5; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - 60 - i); // 60+ days ago
        const timestamp = date.toISOString();
        messages.push(`
## [${timestamp}] 📥 User (message_id: msg-${i})

**Sender**: ou_test_user
**Type**: text

检查 issues

---

`);
      }

      const chatContent = `# Chat Message Log: ${chatId}

**Chat ID**: ${chatId}
**Created**: ${now.toISOString()}
**Last Updated**: ${now.toISOString()}

---

${messages.join('')}
`;

      await fs.writeFile(chatFile, chatContent, 'utf-8');

      analyzer = new BackgroundAnalyzer({
        config: { ...config, lookbackDays: 30, minOccurrences: 3 },
        patternStore,
        messageLogger: mockMessageLogger as any,
      });

      // Override chatDir for testing
      (analyzer as any).chatDir = chatDir;

      const result = await analyzer.runAnalysisNow();

      // Should not find any recent messages
      expect(result.summary.totalPatterns).toBe(0);
    });
  });
});
