import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@larksuiteoapi/node-sdk';
import { changedDocumentFeedback, createDocumentAppender, createDocumentReader, documentToken, type DocumentSnapshot } from './document-source.js';

const reply = (id: string, text: string) => ({ reply_id: id, content: { elements: [{ type: 'text_run', text_run: { text } }] } });
function fixture() {
  const get = vi.fn().mockResolvedValue({ code: 0, data: { document: { revision_id: 3 } } });
  const rawContent = vi.fn().mockResolvedValue({ code: 0, data: { content: 'Compare after-tax totals.' } });
  const list = vi.fn().mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
  const replies = vi.fn();
  const client = { docx: { document: { get, rawContent } }, drive: { fileComment: { list }, fileCommentReply: { list: replies } } } as unknown as Client;
  return { read: createDocumentReader(client), get, rawContent, list, replies };
}

describe('Feishu document snapshots', () => {
  it('collects every comment and nested reply page before producing a snapshot', async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce({ code: 0, data: { has_more: true, page_token: 'next-comments', items: [
      { comment_id: 'c1', quote: 'total', has_more: true, page_token: 'next-replies', reply_list: { replies: [reply('r1', 'Include tax')] } },
    ] } }).mockResolvedValueOnce({ code: 0, data: { has_more: false, items: [
      { comment_id: 'c2', reply_list: { replies: [reply('r3', 'Check currency')] } },
    ] } });
    f.replies.mockResolvedValue({ code: 0, data: { has_more: false, items: [reply('r2', 'Use the 2025 rate')] } });
    const snapshot = await f.read('token');
    expect(snapshot.comments.map(c => c.id)).toEqual(['c1/r1', 'c1/r2', 'c2/r3']);
    expect(snapshot.comments[1].text).toContain('2025');
    expect(f.list.mock.calls[1][0].params.page_token).toBe('next-comments');
    expect(f.replies.mock.calls[0][0].params.page_token).toBe('next-replies');
    expect(snapshot.body).toBe('Compare after-tax totals.');
  });
  it('rejects a failed later comment page rather than returning partial feedback', async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce({ code: 0, data: { has_more: true, page_token: 'next', items: [] } })
      .mockResolvedValueOnce({ code: 99991672 });
    await expect(f.read('token')).rejects.toThrow('未同步');
    expect(f.get).toHaveBeenCalledTimes(1);
  });
  it('rejects a failed nested reply page and a repeated pagination token', async () => {
    const f = fixture();
    f.list.mockResolvedValue({ code: 0, data: { has_more: false, items: [
      { comment_id: 'c1', has_more: true, page_token: 'reply-next', reply_list: { replies: [reply('r1', 'First page only')] } },
    ] } });
    f.replies.mockResolvedValueOnce({ code: 99991672 });
    await expect(f.read('token')).rejects.toThrow('未同步');
    f.replies.mockResolvedValue({ code: 0, data: { has_more: true, page_token: 'reply-next', items: [] } });
    await expect(f.read('token')).rejects.toThrow('未同步');
    expect(f.replies).toHaveBeenCalledTimes(2);
  });
  it('rejects a document edited during collection and oversized text without truncating', async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce({ code: 0, data: { document: { revision_id: 2 } } });
    await expect(f.read('token')).rejects.toThrow('未同步');
    f.rawContent.mockResolvedValue({ code: 0, data: { content: 'x'.repeat(48_001) } });
    await expect(f.read('token')).rejects.toThrow('未同步');
  });
  it('records changed and removed comments without repeating an unchanged snapshot', async () => {
    const base = await fixture().read('token');
    const previous: DocumentSnapshot = { ...base, comments: [{ id: 'c1/r1', text: 'Use old rate' }, { id: 'c2/r1', text: 'Old constraint' }] };
    const next: DocumentSnapshot = { ...base, body: 'New scope', comments: [{ id: 'c1/r1', text: 'Use new rate' }] };
    const changes = changedDocumentFeedback(previous, next);
    expect(changes).toHaveLength(3);
    expect(changes.some(c => c.text.includes('已删除'))).toBe(true);
    expect(changedDocumentFeedback(next, next)).toEqual([]);
  });
  it('excludes only an unchanged published fragment and preserves later user edits', async () => {
    const f = fixture();
    const fragment = 'Research result\nA costs 15, B costs 12';
    f.rawContent.mockResolvedValue({ code: 0, data: { content: `Original source\n${fragment}\n` } });
    const read = await f.read('token', [fragment]);
    expect(read.body).toBe('Original source\n');
    expect(read.rawBody).toContain(fragment);
    f.rawContent.mockResolvedValue({ code: 0, data: { content: 'Original source\nResearch result\nUser correction: A costs 16\n' } });
    expect((await f.read('token', [fragment])).body).toContain('User correction: A costs 16');
  });
  it('extracts only a docx token and never follows arbitrary resource URLs', () => {
    expect(documentToken('https://example.feishu.cn/docx/ABC123?from=test')).toBe('ABC123');
    expect(documentToken('')).toBeUndefined();
    expect(() => documentToken('https://example.feishu.cn/wiki/ABC123')).toThrow('Wiki');
    expect(() => documentToken('file:///docx/ABC123')).toThrow('HTTPS');
  });
});


describe('document append confirmation', () => {
  it('appends using the exact expected revision and idempotency token', async () => {
    const create = vi.fn().mockResolvedValue({ code: 0, data: { children: [{}, {}] } });
    const client = { docx: { documentBlockChildren: { create } } } as unknown as Client;
    await createDocumentAppender(client)('doc', { id: 'operation-1', revision: 7, paragraphs: ['Evidence', 'https://example.com/source'] });
    expect(create).toHaveBeenCalledWith({
      path: { document_id: 'doc', block_id: 'doc' },
      params: { document_revision_id: 7, client_token: 'operation-1' },
      data: { index: -1, children: [
        { block_type: 2, text: { elements: [{ text_run: { content: 'Evidence' } }] } },
        { block_type: 2, text: { elements: [{ text_run: { content: 'https://example.com/source', text_element_style: { link: { url: 'https://example.com/source' } } } }] } },
      ] },
    });
  });
  it.each([{ code: 99991672 }, { code: 0, data: { children: [] } }])('does not confirm an unsuccessful or incomplete append: %j', async response => {
    const create = vi.fn().mockResolvedValue(response);
    const client = { docx: { documentBlockChildren: { create } } } as unknown as Client;
    await expect(createDocumentAppender(client)('doc', { id: 'op', revision: 7, paragraphs: ['Evidence'] })).rejects.toThrow('could not be confirmed');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('snapshot completeness', () => {
  it('rejects a reply element with missing content instead of silently dropping feedback', async () => {
    const f = fixture();
    f.list.mockResolvedValue({ code: 0, data: { has_more: false, items: [
      { comment_id: 'c1', reply_list: { replies: [{ reply_id: 'r1', content: { elements: [{ type: 'text_run' }] } }] } },
    ] } });
    await expect(f.read('token')).rejects.toThrow('未同步');
  });
  it('keeps duplicate published fragments as source material', async () => {
    const f = fixture();
    f.rawContent.mockResolvedValue({ code: 0, data: { content: 'Source\nReport\nReport\n' } });
    expect((await f.read('token', ['Report'])).body).toBe('Source\nReport\nReport\n');
  });
});
