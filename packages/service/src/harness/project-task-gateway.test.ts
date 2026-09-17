import { describe, expect, it, vi } from 'vitest';
import { ProjectTaskGateway, parseTaskOperation } from './project-task-gateway.js';

describe('message-scoped task contexts', () => {
  it('routes only through the issuing channel and revokes its contexts independently', async () => {
    const gateway = new ProjectTaskGateway();
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
    const gateway = new ProjectTaskGateway(() => now, 10, 1), execute = vi.fn().mockResolvedValue({});
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
    expect(parseTaskOperation(create)).toEqual(create);
    expect(parseTaskOperation({ action: 'list', archived: true, limit: 20, offset: 0 })).toMatchObject({ archived: true });
    expect(() => parseTaskOperation({ action: 'list', limit: 100 })).toThrow('list options');
    expect(() => parseTaskOperation({ action: 'constructor' })).toThrow('fields');
    for (const extra of [{ owner: 'bob' }, { chat: 'other' }, { workingDir: '/other' }, { source: 'forged' }]) {
      expect(() => parseTaskOperation({ ...create, ...extra })).toThrow('fields');
    }
    expect(() => parseTaskOperation({ ...create, title: 'x'.repeat(181) })).toThrow('title');
    expect(() => parseTaskOperation({ action: 'control', taskId: 'id', revision: -1, control: 'resume' })).toThrow('control');
    expect(() => parseTaskOperation({ action: 'control', taskId: 'id', revision: 1, control: 'delete' })).toThrow('control');
    expect(() => parseTaskOperation({ action: 'control', taskId: 'id', revision: 1, control: ['resume'] })).toThrow('control');
  });
});
