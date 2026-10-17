import { describe, expect, it, vi } from 'vitest';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import { ChatFailureRegistry, type ChatFailureRecord } from '../../feedback/index.js';
import { handleIssue } from './issue.js';

const record: ChatFailureRecord = {
  chatId: 'chat-1',
  diagnosticId: '55555555-5555-4555-8555-555555555555',
  failureClass: 'provider-stall',
  detail: 'stalled',
  timestamp: '2026-10-17T17:00:00.000Z',
};

function context(overrides: Partial<ControlHandlerContext> = {}): ControlHandlerContext {
  return {
    agentPool: {} as ControlHandlerContext['agentPool'],
    debugGroups: {} as ControlHandlerContext['debugGroups'],
    ...overrides,
  };
}

const command: ControlCommand<'issue'> = { type: 'issue', chatId: 'chat-1' };

describe('/issue command', () => {
  it('is unavailable guidance when the registry is not wired', async () => {
    const response = await handleIssue(command, context());
    expect(response.success).toBe(false);
    expect(response.message).toContain('未启用');
  });

  it('tells the user when the chat has no failure record', async () => {
    const response = await handleIssue(
      command,
      context({ failureRegistry: new ChatFailureRegistry() })
    );
    expect(response.success).toBe(true);
    expect(response.message).toContain('暂无可上报的失败记录');
  });

  it('answers with text-only guidance when the channel cannot render cards', async () => {
    const registry = new ChatFailureRegistry();
    registry.record(record);
    const response = await handleIssue(command, context({ failureRegistry: registry }));
    expect(response.success).toBe(false);
    expect(response.message).toContain('不支持上报确认卡');
  });

  it('delegates the record to the channel hook with thread and actor context', async () => {
    const registry = new ChatFailureRegistry();
    registry.record(record);
    const sendConfirmation = vi.fn().mockResolvedValue({ ok: true });
    const response = await handleIssue(
      { type: 'issue', chatId: 'chat-1', threadRootId: 'om-thread', actorId: 'ou-alice' },
      context({ failureRegistry: registry, issueReporting: { sendConfirmation } })
    );
    expect(sendConfirmation).toHaveBeenCalledExactlyOnceWith(record, {
      chatId: 'chat-1',
      threadRootId: 'om-thread',
      actorId: 'ou-alice',
    });
    expect(response.success).toBe(true);
    expect(response.message).toContain('确认卡');
  });

  it('keeps the record and reports a card delivery failure explicitly', async () => {
    const registry = new ChatFailureRegistry();
    registry.record(record);
    const sendConfirmation = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'card was not delivered' });
    const response = await handleIssue(
      command,
      context({ failureRegistry: registry, issueReporting: { sendConfirmation } })
    );
    expect(response.success).toBe(false);
    expect(response.message).toContain('card was not delivered');
    expect(response.message).toContain('已保留');
    expect(registry.get('chat-1')).toBeDefined();
  });

  it('does not crash the command when the hook throws', async () => {
    const registry = new ChatFailureRegistry();
    registry.record(record);
    const sendConfirmation = vi.fn().mockRejectedValue(new Error('boom'));
    const response = await handleIssue(
      command,
      context({ failureRegistry: registry, issueReporting: { sendConfirmation } })
    );
    expect(response.success).toBe(false);
    expect(response.error).toContain('boom');
  });
});
