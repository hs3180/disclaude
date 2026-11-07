/**
 * Tests for FeishuSideDiscussions (Issue #5412 / T-086).
 *
 * Covers the delivery chain the task requires — entry execution per venue
 * (native thread / topic-group topic / DM), context carry (trigger message
 * excerpt + source refs + boundary), the persisted source link, and
 * conclusion flow-back into the source venue. The lark client is a
 * duck-typed stub injected via the constructor (no vi.mock of the SDK).
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@larksuiteoapi/node-sdk';
import { FeishuSideDiscussions, SideDiscussionStore, positioningPost, conclusionPost, type SideDiscussionRecord } from './side-discussions.js';

function fixture(triggerText?: string) {
  const reply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_side_post' } });
  const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_side_root' } });
  const get = vi.fn().mockImplementation(({ path: { message_id } }: { path: { message_id: string } }) => ({
    code: 0,
    data: { items: message_id === 'om_trigger' && triggerText !== undefined
      ? [{ message_id, body: { content: JSON.stringify({ text: triggerText }) } }]
      : [] },
  }));
  const client = { im: { message: { reply, create, get } } } as unknown as Client;
  const dir = mkdtempSync(join(tmpdir(), 'side-discussions-'));
  const store = new SideDiscussionStore(join(dir, 'side-discussions.json'));
  const component = new FeishuSideDiscussions(client, store);
  const open = (request: Parameters<FeishuSideDiscussions['open']>[0]) => component.open(request);
  // Typed accessors for the first call's arguments (untyped vi.fn() calls are any[][]).
  const firstReply = () => reply.mock.calls[0]![0];
  const firstCreate = () => create.mock.calls[0]![0];
  return { component, store, open, reply, create, get, dir, firstReply, firstCreate };
}

describe('open — native message thread (p2p/plain group)', () => {
  it('replies in-thread on the trigger message and carries its excerpt', async () => {
    const f = fixture('登录偶发 502，疑似 token 刷新竞态');
    try {
      const result = await f.open({
        chatId: 'oc_main', question: '追查登录失败的原因', venue: 'message-thread',
        anchorMessageId: 'om_trigger', triggerMessageId: 'om_trigger',
        commandMessageId: 'om_cmd', chatType: 'group', actorId: 'ou_alice',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) { return; }
      expect(result.message).toContain('side-1');
      expect(f.reply).toHaveBeenCalledTimes(1);
      const call = f.firstReply();
      expect(call.path.message_id).toBe('om_trigger');
      expect(call.data.reply_in_thread).toBe(true);
      const text = JSON.parse(call.data.content).text as string;
      expect(text).toContain('【支线讨论 side-1】追查登录失败的原因');
      expect(text).toContain('来源：会话 oc_main');
      expect(text).toContain('触发消息 om_trigger');
      expect(text).toContain('token 刷新竞态');
      expect(text).toContain('/discuss done side-1');
      expect(f.create).not.toHaveBeenCalled();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('anchors on the command message when not replying and still records the source link', async () => {
    const f = fixture();
    try {
      const result = await f.open({
        chatId: 'oc_main', question: '深挖旁白方案', venue: 'message-thread',
        anchorMessageId: 'om_cmd', commandMessageId: 'om_cmd', chatType: 'p2p', actorId: 'ou_alice',
      });
      expect(result.ok).toBe(true);
      expect(f.reply.mock.calls[0][0].path.message_id).toBe('om_cmd');
      const record = await f.store.find('side-1');
      expect(record).toMatchObject({
        chatId: 'oc_main', venueChatId: 'oc_main', anchorMessageId: 'om_cmd',
        sourceMessageId: 'om_cmd', status: 'open',
      });
      const text = JSON.parse(f.firstReply().data.content).text as string;
      expect(text).toContain('（无，取当前对话背景）');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('opens without the trigger excerpt when the fetch fails or finds nothing', async () => {
    const f = fixture(undefined); // get returns no matching item
    try {
      const result = await f.open({
        chatId: 'oc_main', question: 'q', venue: 'message-thread',
        anchorMessageId: 'om_trigger', triggerMessageId: 'om_trigger', commandMessageId: 'om_cmd',
      });
      expect(result.ok).toBe(true);
      const text = JSON.parse(f.firstReply().data.content).text as string;
      expect(text).toContain('触发消息 om_trigger');
      expect(text).not.toContain('摘录');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses a message-thread venue without an anchor', async () => {
    const f = fixture();
    try {
      const result = await f.open({ chatId: 'oc_main', question: 'q', venue: 'message-thread' });
      expect(result).toMatchObject({ ok: false });
      expect(f.reply).not.toHaveBeenCalled();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('open — topic group and private venues', () => {
  it('starts a new native topic (root message) inside a topic group', async () => {
    const f = fixture();
    try {
      const result = await f.open({
        chatId: 'oc_topics', question: '旁白方案对比', venue: 'topic-thread',
        threadRootId: 'om_current_topic', commandMessageId: 'om_cmd', chatType: 'topic', actorId: 'ou_alice',
      });
      expect(result.ok).toBe(true);
      expect(f.create).toHaveBeenCalledTimes(1);
      const call = f.firstCreate();
      expect(call.params.receive_id_type).toBe('chat_id');
      expect(call.data.receive_id).toBe('oc_topics');
      const text = JSON.parse(call.data.content).text as string;
      expect(text).toContain('【支线讨论 side-1】');
      const record = await f.store.find('side-1');
      expect(record).toMatchObject({ venue: 'topic-thread', anchorMessageId: 'om_side_root', sourceThreadRootId: 'om_current_topic' });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('DMs the requesting user for the private venue', async () => {
    const f = fixture();
    try {
      const result = await f.open({
        chatId: 'oc_main', question: '敏感问题', venue: 'p2p', commandMessageId: 'om_cmd', chatType: 'group', actorId: 'ou_alice',
      });
      expect(result.ok).toBe(true);
      const call = f.firstCreate();
      expect(call.params.receive_id_type).toBe('open_id');
      expect(call.data.receive_id).toBe('ou_alice');
      const record = await f.store.find('side-1');
      expect(record).toMatchObject({ chatId: 'oc_main', venueChatId: 'ou_alice', venue: 'p2p' });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses the private venue without an actor', async () => {
    const f = fixture();
    try {
      expect(await f.open({ chatId: 'oc_main', question: 'q', venue: 'p2p' })).toMatchObject({ ok: false });
      expect(f.create).not.toHaveBeenCalled();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('does not create a group: the delegated-group venue never reaches this component', async () => {
    // chooseSideVenue keeps 'delegated-group' in core; the open request type
    // excludes it. Regression guard: message-thread send failures surface an error.
    const reply = vi.fn().mockResolvedValue({ code: 230002, data: {} });
    const create = vi.fn();
    const client = { im: { message: { reply, create, get: vi.fn() } } } as unknown as Client;
    const dir = mkdtempSync(join(tmpdir(), 'side-discussions-'));
    try {
      const component = new FeishuSideDiscussions(client, new SideDiscussionStore(join(dir, 'side-discussions.json')));
      const result = await component.open({
        chatId: 'oc_main', question: 'q', venue: 'message-thread', anchorMessageId: 'om_trigger',
      });
      expect(result).toMatchObject({ ok: false });
      expect(result.ok ? '' : result.error).toContain('未送达');
      expect(create).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('conclude — conclusion flow-back', () => {
  async function opened(triggerInTopic = false) {
    const f = fixture('触发内容');
    const openResult = await f.open({
      chatId: 'oc_main', question: '追查登录失败的原因', venue: 'message-thread',
      anchorMessageId: 'om_trigger', triggerMessageId: 'om_trigger', commandMessageId: 'om_cmd',
      ...(triggerInTopic ? { threadRootId: 'om_main_topic' } : {}), chatType: 'group', actorId: 'ou_alice',
    });
    expect(openResult.ok).toBe(true);
    f.reply.mockClear();
    return f;
  }

  it('posts the summary back to the source conversation anchored at the command message', async () => {
    const f = await opened();
    try {
      const result = await f.component.conclude({ chatId: 'oc_main', id: 'side-1', summary: '原因是 token 刷新竞态，已加锁修复' });
      expect(result.ok).toBe(true);
      const call = f.firstReply();
      expect(call.path.message_id).toBe('om_cmd');
      expect(call.data.reply_in_thread).toBeUndefined();
      const text = JSON.parse(call.data.content).text as string;
      expect(text).toContain('【支线结论 side-1】');
      expect(text).toContain('token 刷新竞态');
      expect(text).toContain('主线任务未受影响');
      const record = await f.store.find('side-1');
      expect(record).toMatchObject({ status: 'concluded', conclusion: '原因是 token 刷新竞态，已加锁修复' });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('keeps the flow-back inside the source topic when /discuss was typed in one', async () => {
    const f = await opened(true);
    try {
      const result = await f.component.conclude({ chatId: 'oc_main', threadRootId: 'om_trigger', summary: '结论 A' });
      expect(result.ok).toBe(true);
      const call = f.firstReply();
      expect(call.path.message_id).toBe('om_main_topic');
      expect(call.data.reply_in_thread).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('resolves the record from the side venue by thread anchor without an id', async () => {
    const f = await opened();
    try {
      const result = await f.component.conclude({ chatId: 'oc_main', threadRootId: 'om_trigger', summary: '结论 B' });
      expect(result.ok).toBe(true);
      expect(await f.store.find('side-1')).toMatchObject({ status: 'concluded' });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('is idempotent: a concluded record is not re-sent', async () => {
    const f = await opened();
    try {
      await f.component.conclude({ chatId: 'oc_main', id: 'side-1', summary: '结论 C' });
      f.reply.mockClear();
      const again = await f.component.conclude({ chatId: 'oc_main', id: 'side-1', summary: '结论 D' });
      expect(again).toMatchObject({ ok: false });
      if (!again.ok) { expect(again.error).toContain('已'); }
      expect(f.reply).not.toHaveBeenCalled();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('answers unmatched concludes with the active side ids', async () => {
    const f = await opened();
    try {
      // Same chat, but the anchor matches no open record → the error lists actives.
      const result = await f.component.conclude({ chatId: 'oc_main', threadRootId: 'om_nobody', summary: '结论' });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) { expect(result.error).toContain('side-1'); }
      // A chat with no records at all gets the status hint instead.
      const elsewhere = await f.component.conclude({ chatId: 'oc_other', id: 'side-404', summary: '结论' });
      expect(elsewhere).toMatchObject({ ok: false });
      if (!elsewhere.ok) { expect(elsewhere.error).toContain('/discuss status'); }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('persistence and listing', () => {
  it('round-trips records through the store file with monotonic ids', async () => {
    const f = fixture();
    try {
      await f.open({ chatId: 'oc_main', question: '第一个', venue: 'message-thread', anchorMessageId: 'om_a', commandMessageId: 'om_cmd' });
      await f.open({ chatId: 'oc_main', question: '第二个', venue: 'message-thread', anchorMessageId: 'om_b', commandMessageId: 'om_cmd' });
      const raw = JSON.parse(readFileSync(join(f.dir, 'side-discussions.json'), 'utf-8')) as { seq: number; records: SideDiscussionRecord[] };
      expect(raw.seq).toBe(2);
      expect(raw.records.map(record => record.id)).toEqual(['side-1', 'side-2']);
      // A fresh instance over the same file sees the same records.
      const reopened = new FeishuSideDiscussions(
        { im: { message: { reply: vi.fn(), create: vi.fn(), get: vi.fn() } } } as unknown as Client,
        new SideDiscussionStore(join(f.dir, 'side-discussions.json')));
      const list = await reopened.list('oc_main');
      expect(list.map(item => item.id)).toEqual(['side-2', 'side-1']);
      expect(list[0]).toMatchObject({ status: 'open', venue: 'message-thread', anchorMessageId: 'om_b' });
      // The private venue's records are visible from the DM chat too.
      await reopened.open({ chatId: 'oc_group', question: '私聊支线', venue: 'p2p', commandMessageId: 'om_cmd', actorId: 'ou_bob' });
      expect((await reopened.list('ou_bob')).map(item => item.id)).toContain('side-3');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('post composition', () => {
  it('truncates long questions in titles and bounds carried excerpts', async () => {
    const post = positioningPost({
      id: 'side-9', question: 'x'.repeat(80), chatId: 'oc_main', triggerMessageId: 'om_t',
      triggerExcerpt: `摘录${'y'.repeat(500)}`,
    });
    expect(post).toContain(`【支线讨论 side-9】${'x'.repeat(32)}…`);
    expect(post).toContain('摘录');
    const conclusion = conclusionPost({
      id: 'side-9', seq: 9, question: 'q', title: 'q', venue: 'message-thread',
      chatId: 'oc_main', venueChatId: 'oc_main', createdAt: 'now', status: 'open',
    }, '最终结论');
    expect(conclusion).toContain('【支线结论 side-9】q');
    expect(conclusion).toContain('最终结论');

    // The component truncates the fetched trigger text to the excerpt cap.
    const f = fixture('z'.repeat(600));
    try {
      await f.open({
        chatId: 'oc_main', question: 'q', venue: 'message-thread',
        anchorMessageId: 'om_trigger', triggerMessageId: 'om_trigger', commandMessageId: 'om_cmd',
      });
      const text = JSON.parse(f.firstReply().data.content).text as string;
      expect(text).toContain(`${'z'.repeat(400)}…`);
      expect(text).not.toContain('z'.repeat(401));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
