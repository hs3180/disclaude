import type { Context } from '@deepseek-ai/cordis';
import type { CreateAgentOptions } from '@deepseek-ai/dsh-agent';
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { describe, expect, it, vi } from 'vitest';
import { DshNativeApp } from './native-app.js';

function fixture(attachments?: AttachmentStore) {
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
  const ctx = { on: () => () => {}, agents: { create },
    get: (name: string) => name === 'attachments' ? attachments : undefined,
  } as unknown as Context;
  const peer = {} as JsonRpcTransportPeer;
  const app = new DshNativeApp(ctx, peer);
  return { app, tools, create, dispose, agent };
}

const descriptor = {
  name: 'notebook_read_cell',
  description: 'Read shared cell',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
};

describe('DSH native controller tool selection', () => {
  it('opens and accepts text without an attachment store in a minimal profile', async () => {
    const f = fixture();
    await expect(f.app.handleRequest('initialize', { cwd: '/project' })).resolves.toMatchObject({ capabilities: { images: false } });
    await f.app.handleRequest('session/open', { sessionId: 'minimal-text' });
    await f.app.handleRequest('session/prompt', { sessionId: 'minimal-text', contentBlocks: [{ type: 'text', text: 'Read the owned material' }] });
    expect(f.agent.followup).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: 'text', text: 'Read the owned material' }] }));
    await f.app.shutdown();
  });

  it('rejects image input before enqueue when the profile has no attachment store', async () => {
    const f = fixture();
    await f.app.handleRequest('initialize', { cwd: '/project' });
    await f.app.handleRequest('session/open', { sessionId: 'minimal-image' });
    await expect(f.app.handleRequest('session/prompt', { sessionId: 'minimal-image',
      contentBlocks: [{ type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' }],
    })).rejects.toThrow('no attachment store');
    expect(f.agent.followup).not.toHaveBeenCalled();
    await f.app.shutdown();
  });

  it('preserves durable image admission when the profile provides a store', async () => {
    const ref = { attachmentId: 'owned-image', mediaType: 'image/png', bytes: 5, width: 1, height: 1 };
    const saveImages = vi.fn().mockResolvedValue([ref]);
    const f = fixture({ saveImages } as unknown as AttachmentStore);
    await expect(f.app.handleRequest('initialize', { cwd: '/project' })).resolves.toMatchObject({ capabilities: { images: true } });
    await f.app.handleRequest('session/open', { sessionId: 'stored-image' });
    await f.app.handleRequest('session/prompt', { sessionId: 'stored-image',
      contentBlocks: [{ type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' }],
    });
    expect(saveImages).toHaveBeenCalledOnce();
    expect(f.agent.followup).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: 'image', attachment: ref }] }));
    await f.app.shutdown();
  });

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
