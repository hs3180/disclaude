import type { Context } from '@deepseek-ai/cordis';
import type { CreateAgentOptions } from '@deepseek-ai/dsh-agent';
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol';
import { describe, expect, it, vi } from 'vitest';
import { DshNativeApp } from './native-app.js';

function fixture() {
  const tools = {
    schemas: vi.fn().mockReturnValue([{ name: 'read' }, { name: 'bash' }]),
    restrict: vi.fn().mockReturnValue(() => {}),
    guard: vi.fn().mockReturnValue(() => {}),
    register: vi.fn().mockReturnValue(() => {}),
  };
  const agent = { options: {}, followup: vi.fn() };
  const agentCtx = { tools, agent } as unknown as Context;
  const dispose = vi.fn().mockResolvedValue(undefined);
  const create = vi.fn(async (options: CreateAgentOptions) => {
    await options.setup?.(agentCtx);
    return { agent, dispose };
  });
  const ctx = { on: () => () => {}, agents: { create } } as unknown as Context;
  const peer = {} as JsonRpcTransportPeer;
  const app = new DshNativeApp(ctx, peer);
  return { app, tools, create, dispose };
}

const descriptor = {
  name: 'notebook_read_cell',
  description: 'Read shared cell',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
};

describe('DSH native controller tool selection', () => {
  it('keeps the profile registry when the host supplies no filters', async () => {
    const f = fixture();
    await f.app.handleRequest('initialize', { cwd: '/project', tools: [descriptor] });
    await f.app.handleRequest('session/open', { sessionId: 'test-1' });
    expect(f.tools.restrict).not.toHaveBeenCalled();
    expect(f.tools.schemas).toHaveBeenCalledOnce();
    expect(f.tools.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: descriptor.name })
    );
    await f.app.shutdown();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it('keeps the profile default tools when only business definitions are supplied', async () => {
    const f = fixture();
    await f.app.handleRequest('initialize', { cwd: '/project', tools: [descriptor] });
    await f.app.handleRequest('session/open', { sessionId: 'profile-defaults' });
    expect(f.tools.restrict).not.toHaveBeenCalled();
    expect(f.tools.register).toHaveBeenCalledOnce();
    await f.app.shutdown();
  });

  it('rejects ambiguous host names already provided by the profile', async () => {
    const f = fixture();
    await f.app.handleRequest('initialize', {
      cwd: '/project',
      tools: [{ ...descriptor, name: 'read' }],
    });
    await expect(f.app.handleRequest('session/open', { sessionId: 'collision' })).rejects.toThrow(
      'conflicts with DSH profile tool'
    );
    expect(f.tools.register).not.toHaveBeenCalled();
    await f.app.shutdown();
  });

  it.each(['allowedTools', 'disallowedTools'])(
    'rejects a stale %s protocol field without changing the profile',
    async (field) => {
      const f = fixture();
      await expect(
        f.app.handleRequest('initialize', { cwd: '/project', tools: [descriptor], [field]: [] })
      ).rejects.toThrow('Claude-specific');
      expect(f.tools.restrict).not.toHaveBeenCalled();
      expect(f.tools.register).not.toHaveBeenCalled();
      await f.app.shutdown();
    }
  );
});
