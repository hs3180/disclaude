import { describe, expect, it } from 'vitest';
import type { AgentInputContext, IncomingMessage } from '@disclaude/core';
import { bindVerifiedInputContext, getIncomingInputSource, readVerifiedInputSource,
  registerFeishuInputSource } from './input-provenance.js';

function fixture() {
  const message: IncomingMessage = { messageId: 'om-source-file', chatId: 'oc-chat', userId: 'ou-user',
    content: 'attachment', messageType: 'file', metadata: { threadRootId: 'om-topic' } };
  const context: AgentInputContext = { chatId: message.chatId, actorId: message.userId!,
    sourceMessageId: message.messageId, threadRootId: 'om-topic' };
  registerFeishuInputSource(message, 'om-source', 'user');
  return { message, context, source: getIncomingInputSource(message) };
}

describe('Feishu input provenance', () => {
  it('retains the actual media source ID through frozen host snapshots without JSON proof', () => {
    const { message, context, source } = fixture();
    const bound = bindVerifiedInputContext(context, source);
    const snapshot = Object.freeze({ ...bound });
    expect(readVerifiedInputSource(snapshot)).toEqual({ channel: 'feishu', chatId: 'oc-chat', actorId: 'ou-user',
      inputMessageId: 'om-source-file', sourceMessageId: 'om-source', threadRootId: 'om-topic' });
    expect(Object.isFrozen(readVerifiedInputSource(snapshot))).toBe(true);
    expect(JSON.stringify(bound)).toBe(JSON.stringify(context));
    expect(readVerifiedInputSource(JSON.parse(JSON.stringify(bound)))).toBeUndefined();
    expect(getIncomingInputSource({ ...message })).toBeUndefined();
    expect(getIncomingInputSource(JSON.parse(JSON.stringify(message)))).toBeUndefined();
  });

  it.each(['chatId', 'actorId', 'sourceMessageId', 'threadRootId'] as const)(
    'rejects a source reused with another %s both before and after binding', key => {
      const { context, source } = fixture();
      expect(readVerifiedInputSource(bindVerifiedInputContext({ ...context, [key]: 'other' }, source))).toBeUndefined();
      const bound = bindVerifiedInputContext(context, source);
      expect(readVerifiedInputSource({ ...bound, [key]: 'other' })).toBeUndefined();
    });

  it.each([undefined, {}, 'feishu', null])('rejects unregistered references (%s)', source => {
    const { context } = fixture();
    expect(readVerifiedInputSource(bindVerifiedInputContext(context, source))).toBeUndefined();
  });

  it.each(['app', undefined])('does not attest a non-user event (%s)', senderType => {
    const { message } = fixture();
    const fresh = { ...message };
    registerFeishuInputSource(fresh, 'om-source', senderType);
    expect(getIncomingInputSource(fresh)).toBeUndefined();
  });

  it('snapshots original facts and does not upgrade a mutated incoming object', () => {
    const { message, context, source } = fixture();
    message.userId = 'another-user';
    message.metadata!.threadRootId = 'another-topic';
    registerFeishuInputSource(message, 'forged-source', 'user');
    expect(readVerifiedInputSource(bindVerifiedInputContext(context, source))?.actorId).toBe('ou-user');
    expect(readVerifiedInputSource(bindVerifiedInputContext({ ...context, actorId: message.userId }, source))).toBeUndefined();
  });

  it('does not attest an event missing a real actor or source ID', () => {
    const { message } = fixture();
    for (const [userId, sourceId] of [[undefined, 'source'], ['user', '']] as const) {
      const fresh = { ...message, userId };
      registerFeishuInputSource(fresh, sourceId, 'user');
      expect(getIncomingInputSource(fresh)).toBeUndefined();
    }
    expect(readVerifiedInputSource(undefined)).toBeUndefined();
  });
});
