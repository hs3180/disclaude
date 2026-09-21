import { describe, expect, it } from 'vitest';
import { ResearchGateway, parseResearchOperation } from './gateway.js';

describe('ResearchGateway', () => {
  it('binds operations to the issued actor/chat context, not client fields', async () => {
    const seen: unknown[] = [];
    const gateway = new ResearchGateway((context, operation) => {
      seen.push({ context, operation });
      return Promise.resolve({ ok: true, message: 'accepted' });
    });
    const token = gateway.issue({
      actorId: 'ou_real',
      chatId: 'oc_real',
      sourceMessageId: 'om_source',
    });
    await gateway.execute(token, {
      action: 'list',
      owner: 'ou_attacker',
      chatId: 'oc_attacker',
      workingDir: '/tmp/attacker',
    });
    expect(seen[0]).toEqual({
      context: { actorId: 'ou_real', chatId: 'oc_real', sourceMessageId: 'om_source' },
      operation: { action: 'list' },
    });
  });

  it('rejects expired contexts and invalid controls', async () => {
    const gateway = new ResearchGateway(() => Promise.resolve({ ok: true, message: 'accepted' }), {
      ttlMs: 0,
    });
    const token = gateway.issue({
      actorId: 'ou_real',
      chatId: 'oc_real',
      sourceMessageId: 'om_source',
    });
    await expect(gateway.execute(token, { action: 'list' })).rejects.toThrow(/expired/);
    expect(() =>
      parseResearchOperation({ action: 'control', id: 'p', revision: 0, command: 'delete' })
    ).toThrow(/command/);
  });
});
