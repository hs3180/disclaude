import { describe, expect, it, vi } from 'vitest';
import { buildSessionKey, type AgentQueryOptions, type ToolDefinition } from '@disclaude/core';
import type { AgentSessionContext } from '../agents/session-extension.js';
import type { NotebookAgentSessionFactory, NotebookSession } from './agent-session.js';
import { NotebookAgentIntegration } from './agent-integration.js';

function session() {
  const value = {
    inactive: false,
    tools: [] as ToolDefinition[],
    registerAttachments: vi.fn(),
    messageContext: vi.fn(() => Promise.resolve('\nNotebook context')),
    redactEnvironment: vi.fn((env: Record<string, string | undefined>) => {
      delete env.JUPYTERLAB_PASS;
    }),
    stop: vi.fn<NotebookSession['stop']>(() => Promise.resolve([])),
    pause: vi.fn(() => {
      value.inactive = true;
    }),
    dispose: vi.fn(() => {
      value.inactive = true;
    }),
  };
  return value;
}

function context(thread = 'topic'): AgentSessionContext {
  return {
    workingDir: '/owned/project',
    sessionKey: buildSessionKey('chat', thread),
    currentWorkingDir: () => '/owned/project',
    captureFileDelivery: () => ({ sendFile: vi.fn(() => Promise.resolve('file-message')) }),
  };
}

describe('NotebookAgentIntegration', () => {
  it('leaves chats without Notebook references unextended', async () => {
    const factory = vi.fn<NotebookAgentSessionFactory>(() => undefined);
    const integration = new NotebookAgentIntegration(factory, () => '/owned/project');
    expect(integration.createExtension(context())).toBeUndefined();
    expect(await integration.stop('chat', 'topic')).toEqual({
      cancelled: 0,
      alreadyTerminal: 0,
      ownershipLost: 0,
      unknown: 0,
    });
  });

  it('binds Notebook resources to the generic session identity and captured delivery', async () => {
    const notebook = session();
    const factory = vi.fn<NotebookAgentSessionFactory>(() => notebook);
    const integration = new NotebookAgentIntegration(factory, () => '/owned/project');
    const generic = context();
    integration.createExtension(generic);
    const [[bound]] = factory.mock.calls;
    expect(bound).toMatchObject({
      workingDir: generic.workingDir,
      conversationKey: generic.sessionKey,
    });
    expect(bound.currentWorkingDir).toBe(generic.currentWorkingDir);
    expect(bound.delivery).toBe(generic.captureFileDelivery);
    expect(
      await bound.delivery!()!.sendFile('/owned/report.html', new AbortController().signal)
    ).toBe('file-message');
  });

  it('preserves existing tools and redacts a copied SDK environment', () => {
    const notebook = session();
    const hostTool = { name: 'host_tool' } as ToolDefinition;
    const notebookTool = { name: 'notebook_list' } as ToolDefinition;
    notebook.tools.push(notebookTool);
    const integration = new NotebookAgentIntegration(
      () => notebook,
      () => '/owned/project'
    );
    const extension = integration.createExtension(context())!;
    const options: AgentQueryOptions = {
      settingSources: ['project'],
      tools: [hostTool],
      env: { JUPYTERLAB_PASS: 'private-test-value', RETAINED: 'yes' },
    };
    const configured = extension.configureQueryOptions!(options);
    expect(configured.tools).toEqual([hostTool, notebookTool]);
    expect(configured.env).toEqual({ RETAINED: 'yes' });
    expect(options.env).toEqual({ JUPYTERLAB_PASS: 'private-test-value', RETAINED: 'yes' });
    expect(options.tools).toEqual([hostTool]);
  });

  it('registers incoming attachments before building Notebook context', async () => {
    const notebook = session();
    const attachment = {
      id: 'csv',
      fileName: 'data.csv',
      source: 'user' as const,
      localPath: '/private/data.csv',
      createdAt: 1,
    };
    notebook.messageContext.mockImplementation(() => {
      expect(notebook.registerAttachments).toHaveBeenCalledExactlyOnceWith([attachment]);
      return Promise.resolve('\nNotebook attachment csv');
    });
    const integration = new NotebookAgentIntegration(
      () => notebook,
      () => '/owned/project'
    );
    expect(await integration.createExtension(context())!.messageContext!([attachment])).toContain(
      'attachment csv'
    );
  });

  it('keeps connection failure guidance inside the Notebook adapter', async () => {
    const notebook = session();
    notebook.messageContext.mockRejectedValue(new Error('private connection details'));
    const integration = new NotebookAgentIntegration(
      () => notebook,
      () => '/owned/project'
    );
    const guidance = await integration.createExtension(context())!.messageContext!([]);
    expect(guidance).toContain('[Notebook connection unverified]');
    expect(guidance).toContain('Do not create a local replacement or replay an uncertain run');
    expect(guidance).not.toContain('private connection details');
  });

  it('rejects context that completes after the extension is paused', async () => {
    const notebook = session();
    let finish!: (value: string) => void;
    notebook.messageContext.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const integration = new NotebookAgentIntegration(
      () => notebook,
      () => '/owned/project'
    );
    const extension = integration.createExtension(context())!;
    const pending = extension.messageContext!([]);
    extension.pause();
    finish('stale Notebook context');
    await expect(pending).rejects.toThrow('Notebook turn stopped during context loading');
    expect(notebook.pause).toHaveBeenCalledOnce();
  });

  it('stops only the requested thread after inference has paused its extension', async () => {
    const first = session();
    const second = session();
    first.stop.mockResolvedValue([
      { runId: 'owned-run', state: 'cancelled' },
      { runId: 'unknown-run', state: 'unknown' },
    ]);
    const factory = vi
      .fn<NotebookAgentSessionFactory>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const integration = new NotebookAgentIntegration(factory, () => '/owned/project');
    integration.createExtension(context('one'))!.pause();
    integration.createExtension(context('two'));
    expect(await integration.stop('chat', 'one')).toEqual({
      cancelled: 1,
      alreadyTerminal: 0,
      ownershipLost: 0,
      unknown: 1,
    });
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('does not let a disposed older extension remove its replacement', async () => {
    const first = session();
    const second = session();
    const factory = vi
      .fn<NotebookAgentSessionFactory>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const integration = new NotebookAgentIntegration(factory, () => '/owned/project');
    const old = integration.createExtension(context())!;
    integration.createExtension(context());
    old.dispose();
    await integration.stop('chat', 'topic');
    expect(first.stop).not.toHaveBeenCalled();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('reopens the persisted conversation after disposal and cleans its temporary stop session', async () => {
    const first = session();
    const recovered = session();
    recovered.stop.mockResolvedValue([{ runId: 'original-run', state: 'already_terminal' }]);
    const factory = vi
      .fn<NotebookAgentSessionFactory>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(recovered);
    const workingDir = vi.fn(() => '/owned/project');
    const integration = new NotebookAgentIntegration(factory, workingDir);
    integration.createExtension(context())!.dispose();
    expect(await integration.stop('chat', 'topic')).toEqual({
      cancelled: 0,
      alreadyTerminal: 1,
      ownershipLost: 0,
      unknown: 0,
    });
    expect(factory.mock.calls[1][0]).toMatchObject({
      workingDir: '/owned/project',
      conversationKey: buildSessionKey('chat', 'topic'),
    });
    expect(factory.mock.calls[1][0].delivery).toBeUndefined();
    expect(recovered.dispose).toHaveBeenCalledOnce();
  });

  it('reports unavailable stop state and cleans up when remote observation fails', async () => {
    const notebook = session();
    notebook.stop.mockRejectedValue(new Error('remote unavailable'));
    const integration = new NotebookAgentIntegration(
      () => notebook,
      () => '/owned/project'
    );
    expect(await integration.stop('chat')).toMatchObject({
      cancelled: 0,
      unknown: 0,
      unavailable: true,
    });
    expect(notebook.dispose).toHaveBeenCalledOnce();
  });

  it('refuses missing Project fallback without creating a Notebook session', async () => {
    const factory = vi.fn<NotebookAgentSessionFactory>(() => session());
    const integration = new NotebookAgentIntegration(factory, () => {
      throw new Error('Project directory unavailable');
    });
    expect(await integration.stop('chat')).toMatchObject({ cancelled: 0, unavailable: true });
    expect(factory).not.toHaveBeenCalled();
  });
});
