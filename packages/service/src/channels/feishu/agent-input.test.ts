import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { AgentInputRequest } from '@disclaude/core';
import { FeishuAgentInput } from './agent-input.js';

function fixture(secret = false) {
  const patch = vi.fn().mockResolvedValue({ code: 0 });
  const reply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'public-card', chat_id: 'group' } });
  const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'private-card', chat_id: 'private' } });
  const client = { im: { message: { patch, reply, create } } } as unknown as Client;
  const abort = new AbortController();
  const respond = vi.fn().mockResolvedValue(undefined);
  const request: AgentInputRequest = { requestId: 'rpc-99', threadId: 'codex-thread', turnId: 'turn-1', itemId: 'item-1',
    isBlocking: true, signal: abort.signal, respond, questions: secret
      ? [{ id: 'credential', header: 'Private', question: 'Access token', isOther: false, isSecret: true, options: null }]
      : [{ id: 'browser', header: 'Browser', question: 'Choose a browser', isOther: false, isSecret: false,
        options: [{ label: 'Chromium', description: 'Independent profile' }, { label: 'Chrome', description: 'Existing automation browser' }] },
      { id: 'note', header: 'Constraints', question: 'Additional constraints', isOther: true, isSecret: false, options: null }] };
  const controller = new FeishuAgentInput(client);
  const context = { actorId: 'alice', chatId: 'group', sourceMessageId: 'source', threadRootId: 'topic-root' };
  const callback = () => {
    const card = JSON.parse((secret ? create : reply).mock.calls[0][0].data.content);
    const form = card.body.elements.find((e: { tag: string }) => e.tag === 'form');
    return { operator: { open_id: 'alice' }, context: { open_chat_id: secret ? 'private' : 'group', open_message_id: secret ? 'private-card' : 'public-card' },
      action: { name: form.elements.at(-1).name, form_value: secret ? { text_0: 'private-test-secret' } : { choice_0: '0', text_1: 'No extensions' } } };
  };
  return { controller, request, context, abort, respond, patch, reply, create, callback };
}

describe('Feishu native agent input', () => {
  it('requires explicit complete submission from the original actor, card and chat', async () => {
    const f = fixture();
    await f.controller.request(f.request, f.context);
    expect(f.respond).not.toHaveBeenCalled();
    expect(f.reply.mock.calls[0][0].path.message_id).toBe('topic-root');
    const callback = f.callback();
    await f.controller.submit({ ...callback, operator: { open_id: 'mallory' } });
    await f.controller.submit({ ...callback, context: { ...callback.context, open_chat_id: 'another-chat' } });
    await f.controller.submit({ ...callback, context: { ...callback.context, open_message_id: 'old-card' } });
    await f.controller.submit({ ...callback, action: { name: callback.action.name, form_value: {} } });
    expect(f.respond).not.toHaveBeenCalled();
    await f.controller.submit(callback);
    await f.controller.submit(callback);
    expect(f.respond).toHaveBeenCalledExactlyOnceWith({ browser: { answers: ['Chromium'] }, note: { answers: ['No extensions'] } });
    const lastCard = JSON.parse(f.patch.mock.calls.at(-1)![0].data.content);
    expect(JSON.stringify(lastCard)).toContain('已回答');
    expect(lastCard.body.elements.some((e: { tag: string }) => e.tag === 'form')).toBe(false);
  });
  it('consumes once while the response is in flight and rejects an expired form', async () => {
    const f = fixture();
    let release!: () => void;
    f.respond.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    await f.controller.request(f.request, f.context);
    const first = f.controller.submit(f.callback());
    await vi.waitFor(() => expect(f.respond).toHaveBeenCalledTimes(1));
    await f.controller.submit(f.callback());
    release(); await first;
    expect(f.respond).toHaveBeenCalledTimes(1);
    const expired = fixture();
    await expired.controller.request(expired.request, expired.context);
    expired.abort.abort();
    await expired.controller.submit(expired.callback());
    expect(expired.respond).not.toHaveBeenCalled();
    expect(JSON.stringify(expired.patch.mock.calls.at(-1))).toContain('过期');
  });
  it('collects secret answers only in a bound private card and never echoes values', async () => {
    const f = fixture(true);
    await f.controller.request(f.request, f.context);
    expect(f.create.mock.calls[0][0]).toMatchObject({ params: { receive_id_type: 'open_id' }, data: { receive_id: 'alice' } });
    expect(JSON.stringify(f.reply.mock.calls)).not.toContain('Access token');
    await f.controller.submit({ ...f.callback(), context: { ...f.callback().context, open_chat_id: 'group' } });
    expect(f.respond).not.toHaveBeenCalled();
    await f.controller.submit(f.callback());
    expect(f.respond).toHaveBeenCalledExactlyOnceWith({ credential: { answers: ['private-test-secret'] } });
    expect(JSON.stringify([f.reply.mock.calls, f.create.mock.calls, f.patch.mock.calls])).not.toContain('private-test-secret');
  });
  it('does not re-send a consumed answer when repainting the status card fails', async () => {
    const f = fixture();
    await f.controller.request(f.request, f.context);
    f.patch.mockRejectedValue(new Error('network unavailable'));
    await f.controller.submit(f.callback());
    await f.controller.submit(f.callback());
    expect(f.respond).toHaveBeenCalledTimes(1);
  });
});
