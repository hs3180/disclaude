/**
 * Tests for the structured chat history query (Issue #5603).
 *
 * Covers the storage contract shared with MessageLogger: per-day files under
 * `<workspace>/chat/<YYYY-MM-DD>/<chatId>.md`, entry framing, newest-first day
 * ordering, the historyDays default, cross-day limit truncation and the
 * empty-but-not-error case for unknown chats.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const { mockState } = vi.hoisted(() => ({
  mockState: {
    workspaceDir: '/tmp/history-query-test',
    sessionConfig: { historyDays: 7, maxContextLength: 10000 },
  },
}));

vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual<typeof import('@disclaude/core')>('@disclaude/core');
  return {
    ...actual,
    Config: {
      getWorkspaceDir: () => mockState.workspaceDir,
      getSessionRestoreConfig: () => mockState.sessionConfig,
    },
    MESSAGE_LOGGING: { LOGS_DIR: 'chat' },
  };
});

import { queryChatHistory } from './history-query.js';

async function writeDay(date: string, chatId: string, entries: Array<{ dir: 'in' | 'out'; id: string; text: string }>): Promise<void> {
  const dayDir = path.join(mockState.workspaceDir, 'chat', date);
  await fs.mkdir(dayDir, { recursive: true });
  const body = entries.map(entry =>
    `${entry.dir === 'in' ? '👤' : '🤖'} [2026-10-${date.slice(-2)}T09:00:00.000Z] (${entry.id})\n${entry.text}\n\n---\n\n`
  ).join('');
  await fs.writeFile(path.join(dayDir, `${chatId}.md`), body);
}

describe('queryChatHistory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-query-test-'));
    mockState.workspaceDir = tmpDir;
    mockState.sessionConfig = { historyDays: 7, maxContextLength: 10000 };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves an unknown chat to an empty result instead of failing', async () => {
    const result = await queryChatHistory({ chatId: 'no-such-chat' });
    expect(result).toMatchObject({ chatId: 'no-such-chat', days: [], totalMessages: 0, truncatedByLimit: false });
  });

  it('parses entries with direction, timestamp, id and content', async () => {
    await writeDay('2026-10-01', 'c1', [
      { dir: 'in', id: 'm1', text: '你好' },
      { dir: 'out', id: 'm2', text: '收到\n第二行' },
    ]);
    const result = await queryChatHistory({ chatId: 'c1' });
    expect(result.days).toHaveLength(1);
    const [day] = result.days;
    expect(day.date).toBe('2026-10-01');
    expect(day.path).toBe(path.join(tmpDir, 'chat', '2026-10-01', 'c1.md'));
    expect(day.messages).toEqual([
      { direction: 'incoming', timestamp: '2026-10-01T09:00:00.000Z', messageId: 'm1', content: '你好' },
      { direction: 'outgoing', timestamp: '2026-10-01T09:00:00.000Z', messageId: 'm2', content: '收到\n第二行' },
    ]);
    expect(result.totalMessages).toBe(2);
  });

  it('orders days newest-first and caps lookback at the days option', async () => {
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      await writeDay(date, 'c2', [{ dir: 'in', id: `id-${date}`, text: date }]);
    }
    const result = await queryChatHistory({ chatId: 'c2', days: 2 });
    const dates = result.days.map(day => day.date);
    expect(dates).toEqual(['2026-10-03', '2026-10-02']);
  });

  it('defaults lookback to sessionRestore.historyDays', async () => {
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      await writeDay(date, 'c3', [{ dir: 'in', id: `id-${date}`, text: date }]);
    }
    mockState.sessionConfig = { historyDays: 1, maxContextLength: 10000 };
    const result = await queryChatHistory({ chatId: 'c3' });
    expect(result.days.map(day => day.date)).toEqual(['2026-10-03']);
  });

  it('keeps the newest N messages across days under limit and marks truncation', async () => {
    await writeDay('2026-10-01', 'c4', [
      { dir: 'in', id: 'a1', text: 'old-1' },
      { dir: 'in', id: 'a2', text: 'old-2' },
    ]);
    await writeDay('2026-10-02', 'c4', [
      { dir: 'in', id: 'b1', text: 'new-1' },
      { dir: 'in', id: 'b2', text: 'new-2' },
      { dir: 'in', id: 'b3', text: 'new-3' },
    ]);
    const result = await queryChatHistory({ chatId: 'c4', limit: 4 });
    expect(result.truncatedByLimit).toBe(true);
    expect(result.totalMessages).toBe(4);
    // Newest day survives in full; the older day contributes its newest tail.
    expect(result.days[0].messages.map(message => message.messageId)).toEqual(['b1', 'b2', 'b3']);
    expect(result.days[1].messages.map(message => message.messageId)).toEqual(['a2']);
  });

  it('does not mark truncation when everything fits under limit', async () => {
    await writeDay('2026-10-01', 'c5', [{ dir: 'in', id: 'x1', text: 'only' }]);
    const result = await queryChatHistory({ chatId: 'c5', limit: 10 });
    expect(result.truncatedByLimit).toBe(false);
    expect(result.totalMessages).toBe(1);
  });

  it('rejects an empty chatId', async () => {
    await expect(queryChatHistory({ chatId: '  ' })).rejects.toThrow('chatId');
  });
});
