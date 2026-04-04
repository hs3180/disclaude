/**
 * Tests for MessageLogger.getChatHistory() multi-day aggregation.
 *
 * Issue #1863: Tests that getChatHistory reads from multiple days
 * and respects historyDays and maxContextLength configuration.
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
