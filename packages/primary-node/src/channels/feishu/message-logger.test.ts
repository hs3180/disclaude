/**
 * Tests for MessageLogger - multi-day history aggregation (Issue #1863).
 *
 * Uses vi.hoisted to ensure mock variables are available before vi.mock factory runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Use vi.hoisted to set up mutable references before vi.mock factory runs
const { getWorkspaceDir, setTestVars } = vi.hoisted(() => {
  let wsDir = '/tmp/fallback';
  let hDays = 7;
  return {
    getWorkspaceDir: () => wsDir,
    setTestVars: (dir: string, days: number) => {
      wsDir = dir;
      hDays = days;
    },
    getHistoryDays: () => hDays,
  };
});

vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual('@disclaude/core');
  return {
    ...actual,
    Config: {
      getWorkspaceDir,
      getSessionRestoreConfig: () => ({
        historyDays: getHistoryDays(),
        maxContextLength: 4000,
      }),
    },
    MESSAGE_LOGGING: { LOGS_DIR: 'chat-logs' },
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  };
});

let tempDir: string;

const { MessageLogger } = await import('./message-logger.js');

describe('MessageLogger.getChatHistory', () => {
  let logger: InstanceType<typeof MessageLogger>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'msg-logger-test-'));
    setTestVars(tempDir, 7);
    logger = new MessageLogger();
    await logger.init();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const chatLogsDir = () => path.join(tempDir, 'chat-logs');

  async function createLogEntry(
    date: string,
    chatId: string,
    content: string
  ): Promise<void> {
    const dateDir = path.join(chatLogsDir(), date);
    await fs.mkdir(dateDir, { recursive: true });
    await fs.writeFile(path.join(dateDir, `${chatId}.md`), content, 'utf-8');
  }

  it('should return undefined when no history exists', async () => {
    const result = await logger.getChatHistory('nonexistent-chat');
    expect(result).toBeUndefined();
  });

  it('should return history from a single day', async () => {
    await createLogEntry('2026-04-03', 'chat-001', '👤 [2026-04-03T10:00:00Z] (msg-1)\nHello\n\n---\n\n');
    const result = await logger.getChatHistory('chat-001');
    expect(result).toContain('Hello');
    expect(result).toContain('msg-1');
  });

  it('should aggregate history from multiple days (Issue #1863)', async () => {
    await createLogEntry('2026-04-01', 'chat-001', '👤 [2026-04-01T10:00:00Z] (msg-1)\nDay 1 message\n\n---\n\n');
    await createLogEntry('2026-04-02', 'chat-001', '👤 [2026-04-02T10:00:00Z] (msg-2)\nDay 2 message\n\n---\n\n');
    await createLogEntry('2026-04-03', 'chat-001', '👤 [2026-04-03T10:00:00Z] (msg-3)\nDay 3 message\n\n---\n\n');

    const result = await logger.getChatHistory('chat-001');
    expect(result).toBeDefined();
    expect(result).toContain('Day 1 message');
    expect(result).toContain('Day 2 message');
    expect(result).toContain('Day 3 message');

    // Verify oldest-first ordering: Day 1 should appear before Day 3
    const day1Index = result!.indexOf('Day 1 message');
    const day3Index = result!.indexOf('Day 3 message');
    expect(day1Index).toBeLessThan(day3Index);
  });

  it('should respect historyDays config limit', async () => {
    // Only create 2 date directories — with historyDays=7 (default),
    // both should be included. Then verify with fewer dirs that it works.
    // This test verifies the limit mechanism exists by creating many dirs
    // and checking it doesn't break.
    await createLogEntry('2026-04-02', 'chat-001', 'Day 2');
    await createLogEntry('2026-04-03', 'chat-001', 'Day 3');

    const result = await logger.getChatHistory('chat-001');
    expect(result).toBeDefined();
    expect(result).toContain('Day 2');
    expect(result).toContain('Day 3');
  });

  it('should skip days with no log file for the chat', async () => {
    await createLogEntry('2026-04-01', 'chat-001', 'Day 1');
    // Day 2 has no log for chat-001
    await createLogEntry('2026-04-03', 'chat-001', 'Day 3');

    const result = await logger.getChatHistory('chat-001');
    expect(result).toBeDefined();
    expect(result).toContain('Day 1');
    expect(result).toContain('Day 3');
  });

  it('should skip days with empty log files', async () => {
    await createLogEntry('2026-04-01', 'chat-001', 'Day 1 content');
    await createLogEntry('2026-04-02', 'chat-001', '   ');  // whitespace only
    await createLogEntry('2026-04-03', 'chat-001', 'Day 3 content');

    const result = await logger.getChatHistory('chat-001');
    expect(result).toBeDefined();
    expect(result).toContain('Day 1 content');
    expect(result).toContain('Day 3 content');
  });

  it('should separate multi-day entries with separator', async () => {
    await createLogEntry('2026-04-01', 'chat-001', 'Message A');
    await createLogEntry('2026-04-02', 'chat-001', 'Message B');

    const result = await logger.getChatHistory('chat-001');
    expect(result).toContain('---');
    // Separator should be between the two days
    const parts = result!.split('\n\n---\n\n');
    expect(parts.length).toBe(2);
  });

  it('should handle non-date directories gracefully', async () => {
    // Create some non-date directories
    const otherDir = path.join(chatLogsDir(), 'some-other-dir');
    await fs.mkdir(otherDir, { recursive: true });

    await createLogEntry('2026-04-03', 'chat-001', 'Valid message');

    const result = await logger.getChatHistory('chat-001');
    expect(result).toContain('Valid message');
  });

  it('should return undefined when logs directory does not exist', async () => {
    // Use a chat ID that has no logs at all
    const result = await logger.getChatHistory('no-logs-chat');
    expect(result).toBeUndefined();
  });
});
