import { describe, expect, it, vi } from 'vitest';
import { ActionBoundInput } from '@disclaude/core';
import { FeishuPrivateInput } from './private-input.js';

describe('private input transport', () => {
  it('renders an injected operation and routes its value without reflecting it', async () => {
    const secret = 'synthetic-private-value';
    const consume = vi.fn((_value: string) => Promise.resolve('succeeded' as const));
    const audit = vi.fn();
    const handoff = new ActionBoundInput({ id: 'agent-operation', title: 'Agent operation', description: 'One bounded consumer', consume }, audit);
    const send = vi.fn((_message: Record<string, unknown>) => Promise.resolve('card'));
    const transport = new FeishuPrivateInput(handoff, send);
    await transport.request('agent-operation', 'actor', 'chat', 'source');
    const [firstCall] = send.mock.calls;
    const [{ card }] = firstCall;
    expect((card as any).config).toMatchObject({ update_multi: true, enable_forward: false });
    const form = (card as any).body.elements.find((element: any) => element.tag === 'form');
    const [input, button] = form.elements;
    expect(input.input_type).toBe('password');
    expect(button.form_action_type).toBe('submit');
    expect(button).not.toHaveProperty('action_type');
    const [{ value }] = button.behaviors;
    const callback = { operator: { open_id: 'actor' }, context: { open_chat_id: 'chat', open_message_id: 'card' },
      action: { tag: 'button', value, form_value: { credential: secret } } };
    expect(FeishuPrivateInput.isPrivateCallback(callback)).toBe(true);
    await transport.submit(callback);
    await transport.submit(callback);
    expect(consume).toHaveBeenCalledExactlyOnceWith(secret, expect.objectContaining({ actor: 'actor', chat: 'chat', source: 'source' }));
    expect(JSON.stringify([send.mock.calls, audit.mock.calls])).not.toContain(secret);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('已使用') }));
  });

  it('ignores typing callbacks without consuming the one-shot or repainting the card (#5489)', async () => {
    const consume = vi.fn();
    const send = vi.fn().mockResolvedValue('card');
    const update = vi.fn().mockResolvedValue(undefined);
    const input = new FeishuPrivateInput(new ActionBoundInput({ id: 'action', title: 'Input', description: 'One use', consume }, () => {}), send, update);
    await input.request('action', 'actor', 'chat', 'source');
    await input.submit({ operator: { open_id: 'actor' }, context: { open_chat_id: 'chat', open_message_id: 'card' }, action: { tag: 'input' } });
    expect(consume).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('recognizes malformed forms for interception instead of ordinary chat routing', () => {
    for (const action of [{ form_value: null }, { tag: 'input' }, { value: { private_action: null } }]) {
      expect(FeishuPrivateInput.isPrivateCallback({ action })).toBe(true);
    }
    expect(FeishuPrivateInput.isPrivateCallback({ action: 'malformed' })).toBe(false);
  });

  it('removes the previous legacy form controls when the same actor reissues', async () => {
    const send = vi.fn().mockResolvedValueOnce('first-card').mockResolvedValueOnce('second-card');
    const update = vi.fn().mockResolvedValue(undefined);
    const input = new FeishuPrivateInput(new ActionBoundInput({ id: 'action', title: 'Input', description: 'One use', consume: vi.fn() }, () => {}), send, update);
    await input.request('action', 'actor', 'chat', 'source');
    await input.request('action', 'actor', 'chat', 'source-2');
    expect(update).toHaveBeenCalledWith('first-card', expect.objectContaining({ body: { elements: [{ tag: 'markdown', content: expect.stringContaining('重新发起') }] } }));
    expect(JSON.stringify(update.mock.calls)).not.toContain('credential');
  });

  it('invalidates revoked forms and never reflects rejected values, even if patching fails', async () => {
    const consume = vi.fn();
    const send = vi.fn().mockResolvedValue('card');
    const update = vi.fn().mockResolvedValue(undefined);
    const input = new FeishuPrivateInput(new ActionBoundInput({ id: 'action', title: 'Input', description: 'One use', consume }, () => {}), send, update);
    await input.request('action', 'actor', 'chat', 'source');
    input.revoke();
    expect(update).toHaveBeenCalledWith('card', expect.objectContaining({ body: { elements: [{ tag: 'markdown', content: expect.stringContaining('重新发起') }] } }));
    update.mockRejectedValueOnce(new Error('patch unavailable'));
    await FeishuPrivateInput.reject({ context: { open_message_id: 'card', open_chat_id: 'chat' }, action: { form_value: { credential: 'private-rejected-value' } } }, send, update);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('服务重启') }));
    expect(consume).not.toHaveBeenCalled();
    expect(JSON.stringify([send.mock.calls, update.mock.calls])).not.toContain('private-rejected-value');
  });
});
