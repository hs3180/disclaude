import { describe, expect, it, vi } from 'vitest';
import { createControlHandler } from '../handler.js';
import { createControlCommand } from '../normalize.js';
import { commandRegistry } from './index.js';
import type { ControlHandlerContext } from '../types.js';

function context(): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn() },
    debugGroups: { getDebugGroup: () => null, setDebugGroup: vi.fn(), clearDebugGroup: () => null },
  };
}

describe('runtime help and recovery guidance', () => {
  it('omits unavailable integrations and uses the registered descriptions', async () => {
    const handler = createControlHandler(context());
    const status = commandRegistry.find(c => c.type === 'status')!;
    const { description } = status;
    try {
      status.description = 'runtime description';
      const help = await handler({ type: 'help', chatId: 'chat' });
      expect(help.message).toContain('runtime description');
      for (const type of ['agent', 'steer', 'project', 'trigger', 'restart']) {
        expect(help.message).not.toContain(`\`/${type}`);
      }
      expect(help.message).toContain('/reset [--no-context]');
    } finally { status.description = description; }
  });

  it('consumes unavailable commands without running a fallback', async () => {
    const response = await createControlHandler(context())({ type: 'restart', chatId: 'chat' });
    expect(response.success).toBe(false);
    expect(response.message).toContain('当前不可用');
  });

  it('uses the same access decision for help and execution', async () => {
    const ctx = context();
    Object.assign(ctx, { isCommandAllowed: (command: { type: string }) => command.type === 'help' });
    const handler = createControlHandler(ctx);
    expect((await handler({ type: 'help', chatId: 'chat' })).message).not.toContain('`/reset');
    const denied = await handler({ type: 'reset', chatId: 'chat' });
    expect(denied.success).toBe(false);
    expect(denied.message).toContain('权限');
    expect(ctx.agentPool.reset).not.toHaveBeenCalled();
  });

  it('does not leak paths or credentials when a command fails', async () => {
    const ctx = context();
    vi.mocked(ctx.agentPool.reset).mockImplementation(() => { throw new Error('/private/path sk-secret'); });
    const response = await createControlHandler(ctx)({ type: 'reset', chatId: 'chat' });
    expect(response.success).toBe(false);
    expect(response.message).toContain('/help');
    expect(response.message).not.toMatch(/private\/path|sk-secret/);
  });

  it('normalizes help toggles without dropping unknown options', () => {
    expect(createControlCommand('help', 'chat', { args: ['off'] }).data).toEqual({ mode: 'off' });
    expect(createControlCommand('help', 'chat', { args: ['unknown'] }).data).toEqual({ mode: 'unknown' });
    expect(createControlCommand('help', 'chat', { args: [] }).data).toBeUndefined();
  });
});
