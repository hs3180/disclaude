/**
 * Unit tests for the lark-cli doc comment source (T-089 / #5197).
 *
 * The runner is injected (fake) — the real CLI/API surface is UNKNOWN offline;
 * these tests lock the invocation shape, envelope validation, normalization
 * and failure classification instead.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createLarkCliDocCommentSource,
  normalizeDocCommentThread,
  DocCommentSourceError,
} from './feishu-doc-comment-source.js';

function pageResponse(items: unknown[], options?: { hasMore?: boolean; pageToken?: string; docToken?: string }) {
  return {
    ok: true,
    data: {
      file_token: options?.docToken ?? 'doxcnAbc123',
      items,
      has_more: options?.hasMore ?? false,
      ...(options?.pageToken !== undefined ? { page_token: options.pageToken } : {}),
    },
  };
}

const RAW_THREAD = {
  comment_id: 'com1',
  user_id: { open_id: 'ou_author', name: '张三' },
  created_time: 1762400000000,
  modified_time: 1762400001000,
  solved: false,
  is_whole: false,
  reply_list: [{ reply_id: 'rp1', content: '结论与来源二不符', user_id: { open_id: 'ou_author' } }, { reply_id: 'rp2', content: '补充' }],
};

describe('normalizeDocCommentThread', () => {
  it('normalizes the fields the monitor needs and preserves raw', () => {
    const thread = normalizeDocCommentThread(RAW_THREAD);
    expect(thread.commentId).toBe('com1');
    expect(thread.authorId).toBe('ou_author');
    expect(thread.authorName).toBe('张三');
    expect(thread.contentText).toBe('结论与来源二不符');
    expect(thread.createdAtMs).toBe(1762400000000);
    expect(thread.editedAtMs).toBe(1762400001000);
    expect(thread.isWhole).toBe(false);
    expect(thread.isSolved).toBe(false);
    expect(thread.replyCount).toBe(2);
    expect(thread.raw).toEqual(RAW_THREAD);
  });

  it('tolerates unknown shapes: only comment_id is required', () => {
    const thread = normalizeDocCommentThread({ comment_id: 'com2', whatever: { nested: true } });
    expect(thread.commentId).toBe('com2');
    expect(thread.authorId).toBeUndefined();
    expect(thread.contentText).toBeUndefined();
    expect(thread.createdAtMs).toBeUndefined();
    expect(thread.isWhole).toBeUndefined();
  });

  it('rejects items without comment_id as invalid responses', () => {
    expect(() => normalizeDocCommentThread({ reply_list: [] })).toThrow(DocCommentSourceError);
    expect(() => normalizeDocCommentThread('com3')).toThrow(/not an object/);
  });
});

describe('createLarkCliDocCommentSource', () => {
  it('invokes lark-cli with the verified list-comments argument shape', async () => {
    const run = vi.fn(() => Promise.resolve({ stdout: JSON.stringify(pageResponse([])) }));
    const source = createLarkCliDocCommentSource({ run });
    await source.listComments({
      docToken: 'doxcnAbc123', docType: 'docx', identity: 'user', pageSize: 50,
    });
    expect(run).toHaveBeenCalledWith([
      'drive', '+list-comments',
      '--token', 'doxcnAbc123',
      '--type', 'docx',
      '--comment-scope', 'all',
      '--solved-status', 'all',
      '--as', 'user',
      '--page-size', '50',
    ]);

    run.mockResolvedValueOnce({ stdout: JSON.stringify(pageResponse([], { hasMore: true, pageToken: 'pt9' })) });
    await source.listComments({
      docToken: 'doxcnAbc123', docType: 'docx', identity: 'bot', pageSize: 100, pageToken: 'pt8',
    });
    expect(run).toHaveBeenLastCalledWith(expect.arrayContaining(['--as', 'bot', '--page-size', '100', '--page-token', 'pt8']));
  });

  it('returns normalized threads with pagination markers', async () => {
    const run = vi.fn(() => Promise.resolve({ stdout: JSON.stringify(pageResponse([RAW_THREAD], { hasMore: true, pageToken: 'next' })) }));
    const source = createLarkCliDocCommentSource({ run });
    const page = await source.listComments({ docToken: 'doxcnAbc123', docType: 'docx', identity: 'user', pageSize: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].commentId).toBe('com1');
    expect(page.hasMore).toBe(true);
    expect(page.nextPageToken).toBe('next');
  });

  it.each([
    ['ok is not true', () => JSON.stringify({ ok: false, code: 1770002, msg: 'not found' })],
    ['file_token mismatch', () => JSON.stringify(pageResponse([], { docToken: 'otherDoc' }))],
    ['items missing', () => JSON.stringify({ ok: true, data: { file_token: 'doxcnAbc123', has_more: false } })],
    ['has_more not boolean', () => JSON.stringify({ ok: true, data: { file_token: 'doxcnAbc123', items: [], has_more: 'no' } })],
    ['has_more without page_token', () => JSON.stringify({ ok: true, data: { file_token: 'doxcnAbc123', items: [], has_more: true } })],
    ['item missing comment_id', () => JSON.stringify(pageResponse([{ solved: true }]))],
    ['stdout is not JSON', () => 'lark-cli: command not found'],
  ])('rejects an invalid response (%s) as invalid-response', async (_name, buildStdout) => {
    const run = vi.fn(() => Promise.resolve({ stdout: buildStdout() }));
    const source = createLarkCliDocCommentSource({ run });
    await expect(source.listComments({ docToken: 'doxcnAbc123', docType: 'docx', identity: 'user', pageSize: 50 }))
      .rejects.toMatchObject({ name: 'DocCommentSourceError', kind: 'invalid-response' });
  });

  it('classifies CLI exit failures with permission hints as permission', async () => {
    const run = vi.fn(() => Promise.reject(Object.assign(new Error('exit 1'), { stderr: 'no permission to read this doc (access denied)' })));
    const source = createLarkCliDocCommentSource({ run });
    await expect(source.listComments({ docToken: 'doxcnAbc123', docType: 'docx', identity: 'user', pageSize: 50 }))
      .rejects.toMatchObject({ kind: 'permission' });
  });

  it('classifies generic CLI failures as transient (rate limits are indistinguishable offline)', async () => {
    const run = vi.fn(() => Promise.reject(new Error('exit 1')));
    const source = createLarkCliDocCommentSource({ run });
    await expect(source.listComments({ docToken: 'doxcnAbc123', docType: 'docx', identity: 'user', pageSize: 50 }))
      .rejects.toMatchObject({ kind: 'transient' });
  });
});
