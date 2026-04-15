/**
 * Tests for MessageLogger.
 *
 * Issue #1863: Tests that getChatHistory reads from multiple days
 * and respects historyDays and maxContextLength configuration.
 * Issue #1617: Expanded coverage for init, logging, dedup, migration, clearCache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Use vi.hoisted to declare variables accessible from vi.mock factory
const { mockState } = vi.hoisted(() => ({
  mockState: {
    workspaceDir: '/tmp/message-logger-test',
    sessionConfig: { historyDays: 7, maxContextLength: 10000 },
  },
}));

// Mock @disclaude/core Config before importing MessageLogger
vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual<typeof import('@disclaude/core')>('@disclaude/core');
  return {
    ...actual,
    Config: {
      getWorkspaceDir: () => mockState.workspaceDir,
      getSessionRestoreConfig: () => mockState.sessionConfig,
    },
    MESSAGE_LOGGING: { LOGS_DIR: 'chat-logs' },
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

// Import after mocks are set up
import { MessageLogger } from './message-logger.js';

describe('MessageLogger.getChatHistory', () => {
  let tmpDir: string;
  let logger: MessageLogger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-logger-test-'));
    mockState.workspaceDir = tmpDir;
    mockState.sessionConfig = { historyDays: 7, maxContextLength: 10000 };

    // Create a MessageLogger instance with the temp directory
    logger = new MessageLogger();
    await logger.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return undefined when no history exists', async () => {
    const result = await logger.getChatHistory('nonexistent-chat');
    expect(result).toBeUndefined();
  });

  it('should read history from a single day', async () => {
    const dateDir = path.join(tmpDir, 'chat-logs', '2026-04-04');
    await fs.mkdir(dateDir, { recursive: true });
    await fs.writeFile(path.join(dateDir, 'chat-123.md'), 'Hello today\n---\n');

    const result = await logger.getChatHistory('chat-123');
    expect(result).toBe('Hello today\n---');
  });

  it('should aggregate history from multiple days (newest first)', async () => {
    // Create 3 days of history
    const day1 = '2026-04-04';
    const day2 = '2026-04-03';
    const day3 = '2026-04-02';

    for (const day of [day1, day2, day3]) {
      const dateDir = path.join(tmpDir, 'chat-logs', day);
      await fs.mkdir(dateDir, { recursive: true });
      await fs.writeFile(path.join(dateDir, 'chat-456.md'), `Messages from ${day}\n---\n`);
    }

    const result = await logger.getChatHistory('chat-456');

    // Should contain all three days with date separators
    expect(result).toContain('Messages from 2026-04-04');
    expect(result).toContain('Messages from 2026-04-03');
    expect(result).toContain('Messages from 2026-04-02');

    // Newest day should come first
    const idx1 = result!.indexOf('Messages from 2026-04-04');
    const idx2 = result!.indexOf('Messages from 2026-04-03');
    const idx3 = result!.indexOf('Messages from 2026-04-02');
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it('should respect historyDays limit', async () => {
    mockState.sessionConfig = { historyDays: 2, maxContextLength: 10000 };

    // Create 4 days of history
    for (let i = 0; i < 4; i++) {
      const date = `2026-04-0${4 - i}`;
      const dateDir = path.join(tmpDir, 'chat-logs', date);
      await fs.mkdir(dateDir, { recursive: true });
      await fs.writeFile(path.join(dateDir, 'chat-789.md'), `Day ${date}\n---\n`);
    }

    const result = await logger.getChatHistory('chat-789');

    // Should only include 2 most recent days
    expect(result).toContain('Day 2026-04-04');
    expect(result).toContain('Day 2026-04-03');
    expect(result).not.toContain('Day 2026-04-02');
    expect(result).not.toContain('Day 2026-04-01');
  });

  it('should truncate from beginning when exceeding maxContextLength', async () => {
    mockState.sessionConfig = { historyDays: 7, maxContextLength: 50 };

    const dateDir = path.join(tmpDir, 'chat-logs', '2026-04-04');
    await fs.mkdir(dateDir, { recursive: true });

    const longContent = 'A'.repeat(200);
    await fs.writeFile(path.join(dateDir, 'chat-trunc.md'), longContent);

    const result = await logger.getChatHistory('chat-trunc');

    // Should be truncated to maxContextLength
    expect(result).toBeDefined();
    expect(result!.length).toBe(50);
    // Should keep the most recent part (end of string)
    expect(result).toBe('A'.repeat(50));
  });

  it('should skip empty log files', async () => {
    const dateDir1 = path.join(tmpDir, 'chat-logs', '2026-04-04');
    const dateDir2 = path.join(tmpDir, 'chat-logs', '2026-04-03');
    await fs.mkdir(dateDir1, { recursive: true });
    await fs.mkdir(dateDir2, { recursive: true });

    // Day 1: empty
    await fs.writeFile(path.join(dateDir1, 'chat-skip.md'), '   \n  \n');
    // Day 2: has content
    await fs.writeFile(path.join(dateDir2, 'chat-skip.md'), 'Real content here\n---\n');

    const result = await logger.getChatHistory('chat-skip');
    expect(result).toBe('Real content here\n---');
  });

  it('should add date header separator between days', async () => {
    const dateDir1 = path.join(tmpDir, 'chat-logs', '2026-04-04');
    const dateDir2 = path.join(tmpDir, 'chat-logs', '2026-04-03');
    await fs.mkdir(dateDir1, { recursive: true });
    await fs.mkdir(dateDir2, { recursive: true });

    await fs.writeFile(path.join(dateDir1, 'chat-sep.md'), 'Day 1 content');
    await fs.writeFile(path.join(dateDir2, 'chat-sep.md'), 'Day 2 content');

    const result = await logger.getChatHistory('chat-sep');

    // Should have date separator between days
    expect(result).toContain('2026-04-03');
  });
});

describe('MessageLogger.init', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-logger-test-'));
    mockState.workspaceDir = tmpDir;
    mockState.sessionConfig = { historyDays: 7, maxContextLength: 10000 };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should create chat-logs directory on init', async () => {
    const ml = new MessageLogger();
    await ml.init();

    const chatDir = path.join(tmpDir, 'chat-logs');
    const stat = await fs.stat(chatDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should not throw on double init', async () => {
    const ml = new MessageLogger();
    await ml.init();
    await ml.init();

    // Should not create duplicate directories or throw
    const chatDir = path.join(tmpDir, 'chat-logs');
    const stat = await fs.stat(chatDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should auto-init when logging without explicit init', async () => {
    const ml = new MessageLogger();
    // Don't call init() — logging should trigger auto-init
    await ml.logIncomingMessage('msg1', 'user1', 'chat1', 'hello', 'text');

    const chatDir = path.join(tmpDir, 'chat-logs');
    const stat = await fs.stat(chatDir);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('MessageLogger.logIncomingMessage', () => {
  let tmpDir: string;
  let logger: MessageLogger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-logger-test-'));
    mockState.workspaceDir = tmpDir;
    mockState.sessionConfig = { historyDays: 7, maxContextLength: 10000 };
    logger = new MessageLogger();
    await logger.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write incoming message to date-based log file', async () => {
    await logger.logIncomingMessage('msg_001', 'user_abc', 'chat_xyz', 'Hello world', 'text');

    // Find today's log directory
    const chatDir = path.join(tmpDir, 'chat-logs');
    const dirs = await fs.readdir(chatDir);
    const dateDir = dirs.find(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    expect(dateDir).toBeDefined();

    const logContent = await fs.readFile(path.join(chatDir, dateDir!, 'chat_xyz.md'), 'utf-8');
    expect(logContent).toContain('👤');
    expect(logContent).toContain('msg_001');
    expect(logContent).toContain('Hello world');
  });

  it('should mark message as processed after logging', async () => {
    await logger.logIncomingMessage('msg_002', 'user1', 'chat1', 'Test', 'text');

    expect(logger.isMessageProcessed('msg_002')).toBe(true);
  });

  it('should use provided timestamp in log entry', async () => {
    await logger.logIncomingMessage(
      'msg_003', 'user1', 'chat1', 'Timed message', 'text', '2026-01-15T10:30:00.000Z',
    );

    const chatDir = path.join(tmpDir, 'chat-logs');
    const dirs = await fs.readdir(chatDir);
    const dateDir = dirs.find(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const logContent = await fs.readFile(path.join(chatDir, dateDir!, 'chat1.md'), 'utf-8');
    expect(logContent).toContain('2026-01-15T10:30:00.000Z');
  });

  it('should use numeric timestamp correctly', async () => {
    const ts = 1705312200000; // 2024-01-15T10:30:00.000Z
    await logger.logIncomingMessage('msg_004', 'user1', 'chat1', 'Numeric ts', 'text', ts);

    const chatDir = path.join(tmpDir, 'chat-logs');
    const dirs = await fs.readdir(chatDir);
    const dateDir = dirs.find(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const logContent = await fs.readFile(path.join(chatDir, dateDir!, 'chat1.md'), 'utf-8');
    // Numeric timestamp should be converted to ISO string
    expect(logContent).toContain('2024-01-15');
  });

  it('should append multiple messages to same chat file', async () => {
    await logger.logIncomingMessage('msg_a', 'user1', 'chat_multi', 'First', 'text');
    await logger.logIncomingMessage('msg_b', 'user1', 'chat_multi', 'Second', 'text');

    const chatDir = path.join(tmpDir, 'chat-logs');
    const dirs = await fs.readdir(chatDir);
    const dateDir = dirs.find(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const logContent = await fs.readFile(path.join(chatDir, dateDir!, 'chat_multi.md'), 'utf-8');

    expect(logContent).toContain('First');
    expect(logContent).toContain('Second');
    expect(logContent).toContain('msg_a');
    expect(logContent).toContain('msg_b');
  });
});

describe('MessageLogger.logOutgoingMessage', () => {
  let tmpDir: string;
  let logger: MessageLogger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-logger-test-'));
    mockState.workspaceDir = tmpDir;
    mockState.sessionConfig = { historyDays: 7, maxContextLength: 10000 };
    logger = new MessageLogger();
    await logger.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write outgoing message with bot emoji', async () => {
    await logger.logOutgoingMessage('msg_bot1', 'chat1', 'Bot reply', 'text');

    const chatDir = path.join(tmpDir, 'chat-logs');
    const dirs = await fs.readdir(chatDir);
    const dateDir = dirs.find(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const logContent = await fs.readFile(path.join(chatDir, dateDir!, 'chat1.md'), 'utf-8');

    expect(logContent).toContain('🤖');
    expect(logContent).toContain('Bot reply');
    expect(logContent).toContain('msg_bot1');
  });

  it('should use default message type "text" when not specified', async () => {
    await logger.logOutgoingMessage('msg_bot2', 'chat1', 'Default type');

    const chatDir = path.join(tmpDir, 'chat-logs');
    const dirs = await fs.readdir(chatDir);
    const dateDir = dirs.find(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const logContent = await fs.readFile(path.join(chatDir, dateDir!, 'chat1.md'), 'utf-8');

    expect(logContent).toContain('Default type');
  });

  it('should not add outgoing messages to processed cache', async () => {
    await logger.logOutgoingMessage('msg_bot3', 'chat1', 'Not tracked');

    // Outgoing messages should NOT be added to dedup cache
    expect(logger.isMessageProcessed('msg_bot3')).toBe(false);
  });

  it('should use provided timestamp for outgoing message', async () => {
    await logger.logOutgoingMessage(
      'msg_bot4', 'chat1', 'Timed bot', 'text', '2026-06-01T12:00:00.000Z',
    );

    const chatDir = path.join(tmpDir, 'chat-logs');
    const dirs = await fs.readdir(chatDir);
    const dateDir = dirs.find(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const logContent = await fs.readFile(path.join(chatDir, dateDir!, 'chat1.md'), 'utf-8');
    expect(logContent).toContain('2026-06-01T12:00:00.000Z');
  });
});

describe('MessageLogger.isMessageProcessed / clearCache', () => {
  let tmpDir: string;
  let logger: MessageLogger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-logger-test-'));
    mockState.workspaceDir = tmpDir;
    mockState.sessionConfig = { historyDays: 7, maxContextLength: 10000 };
    logger = new MessageLogger();
    await logger.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return false for unprocessed message', () => {
    expect(logger.isMessageProcessed('never_seen')).toBe(false);
  });

  it('should return true after logging incoming message', async () => {
    await logger.logIncomingMessage('msg_dedup', 'user1', 'chat1', 'Content', 'text');
    expect(logger.isMessageProcessed('msg_dedup')).toBe(true);
  });

  it('should clear cache with clearCache', async () => {
    await logger.logIncomingMessage('msg_clear', 'user1', 'chat1', 'Content', 'text');
    expect(logger.isMessageProcessed('msg_clear')).toBe(true);

    logger.clearCache();
    expect(logger.isMessageProcessed('msg_clear')).toBe(false);
  });

  it('should track multiple messages independently', async () => {
    await logger.logIncomingMessage('msg_a', 'user1', 'chat1', 'A', 'text');
    await logger.logIncomingMessage('msg_b', 'user1', 'chat1', 'B', 'text');

    expect(logger.isMessageProcessed('msg_a')).toBe(true);
    expect(logger.isMessageProcessed('msg_b')).toBe(true);
    expect(logger.isMessageProcessed('msg_c')).toBe(false);
  });
});

describe('MessageLogger.migrateLegacyFiles', () => {
  let tmpDir: string;
  let chatDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-logger-test-'));
    mockState.workspaceDir = tmpDir;
    mockState.sessionConfig = { historyDays: 7, maxContextLength: 10000 };
    chatDir = path.join(tmpDir, 'chat-logs');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should migrate flat .md files to date-based structure', async () => {
    // Create a flat .md file (legacy structure)
    await fs.mkdir(chatDir, { recursive: true });
    await fs.writeFile(path.join(chatDir, 'oc_chat123.md'), 'Legacy chat content');

    const ml = new MessageLogger();
    await ml.init();

    // Flat file should be moved to today's date directory
    const [today] = new Date().toISOString().split('T');
    const newPath = path.join(chatDir, today, 'oc_chat123.md');
    const migratedContent = await fs.readFile(newPath, 'utf-8');
    expect(migratedContent).toBe('Legacy chat content');

    // Original file should no longer exist
    await expect(fs.access(path.join(chatDir, 'oc_chat123.md'))).rejects.toThrow();
  });

  it('should migrate old {chatId}/{date}.md structure to {date}/{chatId}.md', async () => {
    await fs.mkdir(chatDir, { recursive: true });
    const legacyChatDir = path.join(chatDir, 'oc_chat456');
    await fs.mkdir(legacyChatDir);
    await fs.writeFile(path.join(legacyChatDir, '2026-03-15.md'), 'Old structure content');

    const ml = new MessageLogger();
    await ml.init();

    // Should be moved to 2026-03-15/oc_chat456.md
    const newPath = path.join(chatDir, '2026-03-15', 'oc_chat456.md');
    const content = await fs.readFile(newPath, 'utf-8');
    expect(content).toBe('Old structure content');
  });

  it('should clean up empty legacy directories after migration', async () => {
    await fs.mkdir(chatDir, { recursive: true });
    const legacyChatDir = path.join(chatDir, 'oc_chat789');
    await fs.mkdir(legacyChatDir);
    await fs.writeFile(path.join(legacyChatDir, '2026-03-10.md'), 'Migrate me');

    const ml = new MessageLogger();
    await ml.init();

    // Legacy directory should be removed (it's now empty)
    await expect(fs.access(legacyChatDir)).rejects.toThrow();
  });

  it('should skip non-date .md files in legacy chat directories', async () => {
    await fs.mkdir(chatDir, { recursive: true });
    const legacyChatDir = path.join(chatDir, 'oc_chat_note');
    await fs.mkdir(legacyChatDir);
    await fs.writeFile(path.join(legacyChatDir, 'notes.md'), 'Not a date');
    await fs.writeFile(path.join(legacyChatDir, '2026-03-20.md'), 'Valid date');

    const ml = new MessageLogger();
    await ml.init();

    // Only the date-formatted file should be migrated
    const newDateDir = path.join(chatDir, '2026-03-20');
    const content = await fs.readFile(path.join(newDateDir, 'oc_chat_note.md'), 'utf-8');
    expect(content).toBe('Valid date');

    // 'notes.md' should remain in the old directory since it's not a valid date
    const remainingFiles = await fs.readdir(legacyChatDir);
    expect(remainingFiles).toContain('notes.md');
  });

  it('should handle init when no legacy files exist', async () => {
    await fs.mkdir(chatDir, { recursive: true });

    const ml = new MessageLogger();
    await ml.init();

    // Should not throw, just create the directory
    const stat = await fs.stat(chatDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
