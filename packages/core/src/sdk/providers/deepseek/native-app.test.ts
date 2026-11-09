import type { Context } from '@deepseek-ai/cordis';
import type { CreateAgentOptions } from '@deepseek-ai/dsh-agent';
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DshNativeApp } from './native-app.js';
import type { DshSkillRegistryLike } from './dsh-skills.js';

function fixture(attachments?: AttachmentStore, skills?: DshSkillRegistryLike) {
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
  const logger = { warn: vi.fn(), info: vi.fn() };
  const ctx = { on: () => () => {}, agents: { create }, logger,
    get: (name: string) =>
      name === 'attachments' ? attachments : name === 'skills' ? skills : undefined,
  } as unknown as Context;
  const peer = {} as JsonRpcTransportPeer;
  const app = new DshNativeApp(ctx, peer);
  return { app, tools, create, dispose, agent, logger };
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

describe('DSH native controller skill registration (#5717)', () => {
  function skillsRegistryFixture() {
    const dispose = vi.fn();
    const providers: { name: string; list: (options: unknown) => Promise<unknown> }[] = [];
    const registry: DshSkillRegistryLike = {
      registerProvider: (create) => {
        const provider = create({ signal: new AbortController().signal, invalidate: () => {} });
        providers.push(provider as { name: string; list: (options: unknown) => Promise<unknown> });
        return dispose;
      },
    };
    return { registry, providers, dispose };
  }

  it('registers the Disclaude provider when the profile exposes ctx.skills', async () => {
    const builtins = await mkdtemp(join(tmpdir(), 'dsh-skills-'));
    const { registry, providers } = skillsRegistryFixture();
    const f = fixture(undefined, registry);
    try {
      const initialized = await f.app.handleRequest('initialize', {
        cwd: '/project',
        skills: { builtinRoot: builtins, projectRoot: '/project' },
      });
      expect(initialized).toMatchObject({ capabilities: { skills: true } });
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe('disclaude');
      await f.app.shutdown();
      // Teardown releases the registration back to the profile registry.
      expect(f.logger.info).toHaveBeenCalledWith(expect.stringMatching(/registered \d+ Disclaude skill/));
    } finally {
      await rm(builtins, { recursive: true, force: true });
    }
  });

  it('reports skills: false without registration when the profile has no ctx.skills', async () => {
    const f = fixture();
    const initialized = await f.app.handleRequest('initialize', {
      cwd: '/project',
      skills: { builtinRoot: '/builtins' },
    });
    expect(initialized).toMatchObject({ capabilities: { skills: false } });
    expect(f.logger.warn).not.toHaveBeenCalled();
    await f.app.shutdown();
  });

  it('reports skills: false when no skills plan was supplied at all', async () => {
    const { registry, providers } = skillsRegistryFixture();
    const f = fixture(undefined, registry);
    const initialized = await f.app.handleRequest('initialize', { cwd: '/project' });
    expect(initialized).toMatchObject({ capabilities: { skills: false } });
    expect(providers).toHaveLength(0);
    await f.app.shutdown();
  });

  it('fails initialize loudly when registration itself throws', async () => {
    const registry: DshSkillRegistryLike = {
      registerProvider: () => {
        throw new Error('a skill provider named "disclaude" is already registered');
      },
    };
    const f = fixture(undefined, registry);
    await expect(
      f.app.handleRequest('initialize', { cwd: '/project', skills: { builtinRoot: '/builtins' } })
    ).rejects.toThrow(
      'Disclaude skills could not be registered on the DSH skills registry: ' +
        'a skill provider named "disclaude" is already registered. ' +
        'Fix the reported skill source, or boot a profile whose skills registry is intact. ' +
        'No prompt manifest was injected and no model turn was submitted.'
    );
    await f.app.shutdown();
  });

  it('rejects a malformed skills plan before touching the profile registry', async () => {
    const { registry, providers } = skillsRegistryFixture();
    const f = fixture(undefined, registry);
    await expect(
      f.app.handleRequest('initialize', { cwd: '/project', skills: { builtinRoot: '' } })
    ).rejects.toThrow('skills.builtinRoot must be a non-empty string');
    expect(providers).toHaveLength(0);
    await f.app.shutdown();
  });
});
