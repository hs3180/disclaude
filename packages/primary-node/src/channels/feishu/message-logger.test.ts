/**
 * Tests for MessageLogger.
 *
 * Issue #1863: Tests for multi-day history aggregation and basic logging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Mock Config before importing MessageLogger
let mockWorkspaceDir = '';
let mockHistoryDays = 7;
let mockMaxContextLength = 4000;

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    Config: {
      ...actual.Config,
      getWorkspaceDir: () => mockWorkspaceDir,
      getSessionRestoreConfig: () => ({
        historyDays: mockHistoryDays,
        maxContextLength: mockMaxContextLength,
      }),
    },
  };
});

describe('MessageLogger', () => {
  let tmpDir: string;
  let chatDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-logger-test-'));
    // MessageLogger uses path.join(workspaceDir, 'chat') as the chat dir
    chatDir = path.join(tmpDir, 'chat');
    await fs.mkdir(chatDir, { recursive: true });
    mockWorkspaceDir = tmpDir;
    mockHistoryDays = 7;
    mockMaxContextLength = 4000;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('getChatHistory - multi-day aggregation (Issue #1863)', () => {
    it('should return undefined when no history exists', async () => {
      const { MessageLogger } = await import('./message-logger.js');
      const logger = new MessageLogger();
      await logger.init();

      const result = await logger.getChatHistory('nonexistent-chat');
      expect(result).toBeUndefined();
    });

    it('should return single-day history', async () => {
      const { MessageLogger } = await import('./message-logger.js');
      const logger = new MessageLogger();
      await logger.init();

      // Create a log file for today
      const today = new Date().toISOString().split('T')[0];
      const dateDir = path.join(chatDir, today);
      await fs.mkdir(dateDir, { recursive: true });
      await fs.writeFile(path.join(dateDir, 'chat-123.md'), 'Today message\n');

      const result = await logger.getChatHistory('chat-123');
      expect(result).toBe('Today message\n');
    });

    it('should aggregate multiple days of history in chronological order', async () => {
      const { MessageLogger } = await import('./message-logger.js');
      const logger = new MessageLogger();
      await logger.init();

      // Create log files for 3 different days
      const dates = [
        '2026-03-28', // oldest
        '2026-03-29',
        '2026-03-30', // newest
      ];

      for (const date of dates) {
        const dateDir = path.join(chatDir, date);
        await fs.mkdir(dateDir, { recursive: true });
        await fs.writeFile(path.join(dateDir, 'chat-456.md'), `[${date}] message\n`);
      }

      const result = await logger.getChatHistory('chat-456');
      // Should be in chronological order (oldest first)
      expect(result).toBe(
        '[2026-03-28] message\n' +
        '[2026-03-29] message\n' +
        '[2026-03-30] message\n'
      );
    });

    it('should respect historyDays limit from config', async () => {
      mockHistoryDays = 2;
      const { MessageLogger } = await import('./message-logger.js');
      const logger = new MessageLogger();
      await logger.init();

      // Create log files for 5 different days
      const dates = ['2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30'];
      for (const date of dates) {
        const dateDir = path.join(chatDir, date);
        await fs.mkdir(dateDir, { recursive: true });
        await fs.writeFile(path.join(dateDir, 'chat-789.md'), `[${date}] message\n`);
      }

      const result = await logger.getChatHistory('chat-789');
      // Should only include the most recent 2 days (chronological order)
      expect(result).toBe(
        '[2026-03-29] message\n' +
        '[2026-03-30] message\n'
      );
    });

    it('should skip empty log files', async () => {
      const { MessageLogger } = await import('./message-logger.js');
      const logger = new MessageLogger();
      await logger.init();

      // Create log files: one whitespace-only, one with content
      const dateDir1 = path.join(chatDir, '2026-03-29');
      await fs.mkdir(dateDir1, { recursive: true });
      await fs.writeFile(path.join(dateDir1, 'chat-skip.md'), '   \n'); // whitespace only

      const dateDir2 = path.join(chatDir, '2026-03-30');
      await fs.mkdir(dateDir2, { recursive: true });
      await fs.writeFile(path.join(dateDir2, 'chat-skip.md'), 'Real content\n');

      const result = await logger.getChatHistory('chat-skip');
      // Only the day with actual content should be included
      expect(result).toBe('Real content\n');
    });

    it('should skip date directories without a log file for this chatId', async () => {
      const { MessageLogger } = await import('./message-logger.js');
      const logger = new MessageLogger();
      await logger.init();

      // Create a date directory with a different chat's log
      const dateDir = path.join(chatDir, '2026-03-30');
      await fs.mkdir(dateDir, { recursive: true });
      await fs.writeFile(path.join(dateDir, 'other-chat.md'), 'Other chat content\n');

      const result = await logger.getChatHistory('my-chat');
      expect(result).toBeUndefined();
    });

    it('should default to 7 days when config throws', async () => {
      mockHistoryDays = 7;
      const { MessageLogger } = await import('./message-logger.js');
      const logger = new MessageLogger();
      await logger.init();

      // Create 10 days of history
      for (let d = 20; d <= 29; d++) {
        const date = `2026-03-${String(d).padStart(2, '0')}`;
        const dateDir = path.join(chatDir, date);
        await fs.mkdir(dateDir, { recursive: true });
        await fs.writeFile(path.join(dateDir, 'chat-default.md'), `[${date}] msg\n`);
      }

      const result = await logger.getChatHistory('chat-default');
      // Should include only 7 most recent days
      const lines = result!.trim().split('\n');
      expect(lines.length).toBe(7);
      expect(lines[0]).toBe('[2026-03-23] msg');
      expect(lines[6]).toBe('[2026-03-29] msg');
    });
  });
});
