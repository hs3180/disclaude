import { describe, expect, it, vi } from 'vitest';
import { ActionBoundInput } from './action-bound-input.js';

const secret = 'synthetic-private-input';
function setup() {
  let now = 1000;
  const audit = vi.fn();
  const consume = vi.fn((_value: string) => Promise.resolve('succeeded' as const));
  const action = new ActionBoundInput({ id: 'test-operation', title: 'Test', description: 'Bounded test consumer', consume }, audit, () => now);
  const issued = action.issue('test-operation', 'actor', 'chat', 'source');
  action.bindCard(issued.nonce, 'card');
  const input = { actor: 'actor', chat: 'chat', card: 'card', action: 'test-operation', source: 'source', nonce: issued.nonce, value: secret };
  return { action, input, consume, audit, expire: () => {now += 300000;} };
}

describe('action-bound private input', () => {
  it('hands concurrent callbacks to the installed consumer exactly once', async () => {
    const { action, input, consume, audit } = setup();
    const results = await Promise.all([action.submit(input), action.submit(input)]);
    expect(results).toEqual(['succeeded', 'invalid']);
    expect(consume).toHaveBeenCalledExactlyOnceWith(secret, expect.objectContaining({ actor: 'actor', chat: 'chat', source: 'source', action: 'test-operation' }));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([results, audit.mock.calls, action])).not.toContain(secret);
    expect(audit.mock.calls[0][0].correlationId).not.toBe(input.nonce);
  });

  it.each(['actor', 'chat', 'card', 'source', 'nonce', 'action'])('rejects mismatched %s before handoff', async field => {
    const { action, input, consume } = setup();
    expect(await action.submit({ ...input, [field]: 'different' })).toBe('invalid');
    expect(consume).not.toHaveBeenCalled();
  });

  it('rejects expiry, reissue, shutdown and callbacks from another instance', async () => {
    const { action, input, expire } = setup();
    expect(await setup().action.submit(input)).toBe('invalid');
    expire();
    expect(await action.submit(input)).toBe('invalid');
    const fresh = action.issue('test-operation', 'actor', 'chat', 'source');
    action.bindCard(fresh.nonce, 'card');
    action.issue('test-operation', 'actor', 'chat', 'source');
    expect(await action.submit({ ...input, nonce: fresh.nonce })).toBe('invalid');
    action.revoke();
    expect(await action.submit(input)).toBe('invalid');
    expect(() => action.issue('arbitrary-operation', 'actor', 'chat', 'source')).toThrow();
  });

  it('never serializes consumer errors and consumes failed attempts', async () => {
    const { action, input, consume, audit } = setup();
    consume.mockRejectedValueOnce(new Error(secret, { cause: { token: secret } }));
    expect(await action.submit(input)).toBe('failed');
    expect(await action.submit(input)).toBe('invalid');
    expect(JSON.stringify(audit.mock.calls)).not.toContain(secret);
  });
});
