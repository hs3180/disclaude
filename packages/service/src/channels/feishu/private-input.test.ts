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
    const form = (card as any).body.elements.find((element: any) => element.tag === 'form');
    const [input, button] = form.elements;
    expect(input.input_type).toBe('password');
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

  it('recognizes malformed forms for interception instead of ordinary chat routing', () => {
    for (const action of [{ form_value: null }, { tag: 'input' }, { value: { private_action: null } }]) {
      expect(FeishuPrivateInput.isPrivateCallback({ action })).toBe(true);
    }
    expect(FeishuPrivateInput.isPrivateCallback({ action: 'malformed' })).toBe(false);
  });
});
