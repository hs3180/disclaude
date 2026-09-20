import { describe, expect, it, vi } from 'vitest';
import { ResearchContextGateway, parseResearchOperation } from './context.js';

describe('message-scoped task contexts', () => {
  it('routes only through the issuing channel and revokes its contexts independently', async () => {
    const gateway = new ResearchContextGateway();
    const a = vi.fn().mockResolvedValue({ actor: 'alice' }), b = vi.fn().mockResolvedValue({ actor: 'bob' });
    const one = gateway.issue('app-a', a), two = gateway.issue('app-b', b);
    await expect(gateway.execute(one, { action: 'list' })).resolves.toEqual({ actor: 'alice' });
    expect(a).toHaveBeenCalledExactlyOnceWith({ action: 'list' }); expect(b).not.toHaveBeenCalled();
    await expect(gateway.execute(one, { action: 'list', owner: 'bob', chat: 'other' })).rejects.toThrow('fields');
    gateway.revoke('app-a');
    await expect(gateway.execute(one, { action: 'list' })).rejects.toThrow('unavailable');
    await expect(gateway.execute(two, { action: 'list' })).resolves.toEqual({ actor: 'bob' });
  });
  it('expires contexts and bounds outstanding grants without replacing live authority', async () => {
    let now = 0;
    const gateway = new ResearchContextGateway(() => now, 10, 1), execute = vi.fn().mockResolvedValue({});
    const old = gateway.issue('app', execute);
    expect(() => gateway.issue('app', execute)).toThrow('capacity');
    now = 10;
    await expect(gateway.execute(old, { action: 'list' })).rejects.toThrow('expired');
    const fresh = gateway.issue('app', execute);
    await gateway.execute(fresh, { action: 'list' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects forged identity/directory, invalid controls and oversized input before execution', () => {
    const create = { action: 'create', requestId: 'one', title: 'Investigate logs' };
    expect(parseResearchOperation(create)).toEqual(create);
    expect(parseResearchOperation({ action: 'list', archived: true, limit: 20, offset: 0 })).toMatchObject({ archived: true });
    expect(() => parseResearchOperation({ action: 'list', limit: 100 })).toThrow('list options');
    expect(() => parseResearchOperation({ action: 'constructor' })).toThrow('fields');
    for (const extra of [{ owner: 'bob' }, { chat: 'other' }, { workingDir: '/other' }, { source: 'forged' }]) {
      expect(() => parseResearchOperation({ ...create, ...extra })).toThrow('fields');
    }
    expect(() => parseResearchOperation({ ...create, title: 'x'.repeat(181) })).toThrow('title');
    expect(() => parseResearchOperation({ action: 'control', researchId: 'id', revision: -1, control: 'resume' })).toThrow('control');
    expect(() => parseResearchOperation({ action: 'control', researchId: 'id', revision: 1, control: 'delete' })).toThrow('control');
  });
});
