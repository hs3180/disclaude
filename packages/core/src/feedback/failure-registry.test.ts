import { describe, expect, it } from 'vitest';
import { ChatFailureRegistry, type ChatFailureRecord } from './failure-registry.js';

function record(overrides: Partial<ChatFailureRecord> = {}): ChatFailureRecord {
  return {
    chatId: 'chat-1',
    diagnosticId: '11111111-1111-4111-8111-111111111111',
    failureClass: 'provider-turn-failed',
    detail: 'sanitized detail',
    timestamp: '2026-10-17T15:00:00.000Z',
    ...overrides,
  };
}

describe('ChatFailureRegistry', () => {
  it('keeps the last failure per chat', () => {
    const registry = new ChatFailureRegistry();
    registry.record(record());
    const latest = record({ diagnosticId: '22222222-2222-4222-8222-222222222222' });
    registry.record(latest);
    expect(registry.get('chat-1')).toEqual(latest);
  });

  it('tracks chats independently', () => {
    const registry = new ChatFailureRegistry();
    registry.record(record({ chatId: 'chat-1' }));
    registry.record(record({ chatId: 'chat-2', failureClass: 'agent-loop-error' }));
    expect(registry.get('chat-1')?.failureClass).toBe('provider-turn-failed');
    expect(registry.get('chat-2')?.failureClass).toBe('agent-loop-error');
  });

  it('drops the least recently updated chat at capacity', () => {
    const registry = new ChatFailureRegistry(2);
    registry.record(record({ chatId: 'a' }));
    registry.record(record({ chatId: 'b' }));
    registry.record(record({ chatId: 'a' })); // refresh a
    registry.record(record({ chatId: 'c' })); // evicts b, not a
    expect(registry.get('a')).toBeDefined();
    expect(registry.get('b')).toBeUndefined();
    expect(registry.get('c')).toBeDefined();
  });

  it('ignores records without identity fields', () => {
    const registry = new ChatFailureRegistry();
    registry.record(record({ chatId: '' }));
    registry.record(record({ diagnosticId: '' }));
    expect(registry.get('')).toBeUndefined();
  });

  it('clear removes a chat record', () => {
    const registry = new ChatFailureRegistry();
    registry.record(record());
    registry.clear('chat-1');
    expect(registry.get('chat-1')).toBeUndefined();
  });
});
