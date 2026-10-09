import { describe, expect, it } from 'vitest';
// @ts-expect-error plain executable module
import { feishuSnapshot } from './feishu-snapshot.mjs';

const fixture = () => ({
  document: { ok: true, data: { document: { document_id: 'doc', revision_id: 4, content: 'User body\n\n' } } },
  commentPages: [{ ok: true, data: { file_token: 'doc', has_more: false, items: [{ comment_id: 'thread' }] } }],
  replyPages: [{ commentId: 'thread', pages: [{ ok: true, data: {
    file_token: 'doc', comment_id: 'thread', has_more: false,
    items: [{ reply_id: 'reply', content: { elements: [{ type: 'text_run', text_run: { text: '用户原文\n' } }] } }],
  } }] }],
});

describe('saved Feishu snapshot conversion', () => {
  it('preserves exact body and reply bytes with stable identities across JSON reloads', () => {
    const input = fixture();
    const snapshot = feishuSnapshot(input);
    expect(snapshot).toEqual({ documentId: 'doc', revision: '4', body: 'User body\n\n',
      comments: [{ id: 'thread:reply', body: '用户原文\n' }], complete: true });
    expect(feishuSnapshot(JSON.parse(JSON.stringify(input)))).toEqual(snapshot);
    input.replyPages[0].pages[0].data.items[0].content.elements[0].text_run.text = '没有末尾换行';
    expect(feishuSnapshot(input).comments[0].body).toBe('没有末尾换行');
  });
  it('collects multiple comment and reply pages without losing later replies', () => {
    const input = fixture();
    const second = fixture().replyPages[0];
    second.commentId = 'thread-two';
    second.pages[0].data.comment_id = 'thread-two';
    input.commentPages[0].data.has_more = true;
    input.commentPages.push({ ok: true, data: { file_token: 'doc', has_more: false, items: [{ comment_id: 'thread-two' }] } });
    const nextReplyPage = fixture().replyPages[0].pages[0];
    nextReplyPage.data.items[0].reply_id = 'later-reply';
    input.replyPages[0].pages[0].data.has_more = true;
    input.replyPages[0].pages.push(nextReplyPage);
    input.replyPages.push(second);
    expect(feishuSnapshot(input).comments.map((comment: { id: string }) => comment.id))
      .toEqual(['thread:reply', 'thread:later-reply', 'thread-two:reply']);
  });
  it('rejects missing thread or reply pages rather than claim a complete snapshot', () => {
    const input = fixture();
    input.commentPages[0].data.has_more = true;
    expect(() => feishuSnapshot(input)).toThrow('incomplete_or_extra_pages');
    input.commentPages[0].data.has_more = false;
    input.replyPages[0].pages[0].data.has_more = true;
    expect(() => feishuSnapshot(input)).toThrow('incomplete_or_extra_pages');
    input.replyPages = [];
    expect(() => feishuSnapshot(input)).toThrow('missing_pages');
  });
  it('rejects another document or thread and duplicate reply identity', () => {
    const input = fixture();
    input.replyPages[0].pages[0].data.file_token = 'other';
    expect(() => feishuSnapshot(input)).toThrow('invalid_page_document');
    input.replyPages[0].pages[0].data.file_token = 'doc';
    input.replyPages[0].pages[0].data.comment_id = 'other';
    expect(() => feishuSnapshot(input)).toThrow('reply_thread_mismatch');
    input.replyPages[0].pages[0].data.comment_id = 'thread';
    input.replyPages[0].pages[0].data.items.push(input.replyPages[0].pages[0].data.items[0]);
    expect(() => feishuSnapshot(input)).toThrow('duplicate_or_invalid_reply');
  });
  it('does not silently drop unsupported rich content or failed responses', () => {
    const input = fixture();
    input.replyPages[0].pages[0].data.items[0].content.elements[0].type = 'image';
    expect(() => feishuSnapshot(input)).toThrow('unsupported_reply_content');
    input.replyPages[0].pages[0].ok = false;
    expect(() => feishuSnapshot(input)).toThrow('invalid_page_document');
  });
});
