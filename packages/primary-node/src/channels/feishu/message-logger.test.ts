/**
 * Tests for MessageLogger.getChatHistory() multi-day aggregation.
 *
 * Issue #1863: Chat history was only reading the most recent single day's log.
 * This test suite verifies multi-day aggregation, config limits, empty file skipping,
 * chronological ordering, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

// We need to test the MessageLogger class with a real filesystem.
// Mock Config before importing MessageLogger
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    Config: {
      ...actual.Config,
      getWorkspaceDir: vi.fn().mockReturnValue(os.tmpdir()),
      getSessionRestoreConfig: vi.fn().mockReturnValue({ historyDays: 7 }),
    },
    MESSAGE_LOGGING: actual.MESSAGE_LOGGING,
    createLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

// Dynamic import after mock is set up
const { MessageLogger } = await import('./message-logger.js');

describe('MessageLogger.getChatHistory', () => {
  let tmpDir: string;
  let chatDir: string;
  let logger: InstanceType<typeof MessageLogger>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-logger-test-'));
    chatDir = path.join(tmpDir, 'chat-logs');
    await fs.mkdir(chatDir, { recursive: true });

    // Set the chatDir on the logger instance by creating a new instance
    // with the workspace pointing to our tmpDir
    logger = new MessageLogger();

    // Manually override the private chatDir via prototype
    (logger as any).chatDir = chatDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a date directory and a chat log file */
  async function createLogEntry(dateStr: string, chatId: string, content: string): Promise<void> {
    const dateDir = path.join(chatDir, dateStr);
    await fs.mkdir(dateDir, { recursive: true });
    await fs.writeFile(path.join(dateDir, `${chatId}.md`), content, 'utf-8');
  }

  it('should return undefined when no log files exist', async () => {
    const result = await logger.getChatHistory('nonexistent-chat');
    expect(result).toBeUndefined();
  });

  it('should return content from a single day', async () => {
    await createLogEntry('2026-04-01', 'oc_test123', 'Hello from today');

    const result = await logger.getChatHistory('oc_test123');
    expect(result).toBe('Hello from today');
  });

  it('should aggregate multiple days in chronological order', async () => {
    await createLogEntry('2026-03-30', 'oc_test123', 'Day 1 content');
    await createLogEntry('2026-03-31', 'oc_test123', 'Day 2 content');
    await createLogEntry('2026-04-01', 'oc_test123', 'Day 3 content');

    const result = await logger.getChatHistory('oc_test123');
    expect(result).toBe('Day 1 content\n\n---\n\nDay 2 content\n\n---\n\nDay 3 content');
  });

  it('should skip empty log files', async () => {
    await createLogEntry('2026-03-30', 'oc_test123', '   \n\n   ');  // whitespace only
    await createLogEntry('2026-03-31', 'oc_test123', 'Real content');
    await createLogEntry('2026-04-01', 'oc_test123', '   ');  // whitespace only

    const result = await logger.getChatHistory('oc_test123');
    expect(result).toBe('Real content');
  });

  it('should skip dates that have no log file for the chat', async () => {
    await createLogEntry('2026-03-30', 'oc_other_chat', 'Other chat content');
    await createLogEntry('2026-03-31', 'oc_test123', 'Target chat content');

    const result = await logger.getChatHistory('oc_test123');
    expect(result).toBe('Target chat content');
  });

  it('should respect historyDays config limit', async () => {
    // Create 10 days of logs
    for (let i = 20; i < 30; i++) {
      const dateStr = `2026-03-${String(i).padStart(2, '0')}`;
      await createLogEntry(dateStr, 'oc_test123', `Day ${i} content`);
    }

    // Default historyDays is 7, so should only get the last 7 days (23-29)
    const result = await logger.getChatHistory('oc_test123');
    const parts = result!.split('\n\n---\n\n');
    expect(parts.length).toBe(7);
    expect(parts[0]).toBe('Day 23 content');
    expect(parts[6]).toBe('Day 29 content');
  });

  it('should handle non-date directories gracefully', async () => {
    // Create a non-date directory
    const nonDateDir = path.join(chatDir, 'some-random-dir');
    await fs.mkdir(nonDateDir, { recursive: true });
    await fs.writeFile(path.join(nonDateDir, 'oc_test123.md'), 'Should be ignored');

    // Create a valid date directory
    await createLogEntry('2026-04-01', 'oc_test123', 'Valid content');

    const result = await logger.getChatHistory('oc_test123');
    expect(result).toBe('Valid content');
  });

  it('should return undefined when chatDir does not exist', async () => {
    const logger2 = new MessageLogger();
    (logger2 as any).chatDir = '/nonexistent/path/to/chat-logs';

    const result = await logger2.getChatHistory('oc_test123');
    expect(result).toBeUndefined();
  });

  it('should handle single day with multiple trailing newlines', async () => {
    await createLogEntry('2026-04-01', 'oc_test123', 'Content with trailing\n\n\n\n');

    const result = await logger.getChatHistory('oc_test123');
    // trim() removes trailing whitespace before joining
    expect(result).toBe('Content with trailing');
  });
});
