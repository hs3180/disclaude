import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { InlineToolDefinition, McpServerConfig } from '../../types.js';
import { createCodexDynamicToolRegistry } from './dynamic-tools.js';

describe('Codex app-server dynamic tools', () => {
  it('exposes inline MCP definitions as namespaced JSON-schema tools and dispatches calls', async () => {
    const handler = vi.fn((params: { path: string }) =>
      Promise.resolve({ documentId: 'doc-1', path: params.path })
    );
    const tool: InlineToolDefinition<{ path: string }, { documentId: string; path: string }> = {
      name: 'read_notebook',
      description: 'Read a notebook by server path',
      parameters: z.object({ path: z.string() }),
      handler,
    };
    const registry = createCodexDynamicToolRegistry({
      jupyter: { name: 'jupyter', version: '1.0.0', tools: [tool] } as McpServerConfig,
    });

    expect(registry.specs).toEqual([
      {
        type: 'namespace',
        name: 'jupyter',
        description: 'Inline tools exposed by jupyter',
        tools: [
          {
            type: 'function',
            name: 'read_notebook',
            description: 'Read a notebook by server path',
            inputSchema: expect.objectContaining({ type: 'object', required: ['path'] }),
          },
        ],
      },
    ]);
    const controller = new AbortController();
    await expect(
      registry.call({
        requestId: 'rpc-1',
        callId: 'call-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        namespace: 'jupyter',
        tool: 'read_notebook',
        arguments: { path: 'research.ipynb' },
        signal: controller.signal,
      })
    ).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: '{"documentId":"doc-1","path":"research.ipynb"}' }],
      success: true,
    });
    expect(handler).toHaveBeenCalledWith({ path: 'research.ipynb' }, undefined, {
      signal: controller.signal,
    });
  });

  it('validates arguments and avoids running unknown or cancelled calls', async () => {
    const handler = vi.fn(() => Promise.resolve('should not run'));
    const registry = createCodexDynamicToolRegistry({
      jupyter: {
        type: 'inline',
        name: 'jupyter',
        version: '1.0.0',
        tools: [
          {
            name: 'read_notebook',
            description: 'Read a notebook',
            parameters: z.object({ path: z.string() }),
            handler,
          },
        ],
      },
    });
    const baseRequest = {
      requestId: 1,
      callId: 'call-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      namespace: 'jupyter',
      tool: 'read_notebook',
      signal: new AbortController().signal,
    };

    await expect(registry.call({ ...baseRequest, arguments: { path: 42 } })).resolves.toMatchObject(
      { success: false }
    );
    await expect(
      registry.call({ ...baseRequest, tool: 'missing', arguments: {} })
    ).resolves.toMatchObject({ success: false });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      registry.call({ ...baseRequest, arguments: { path: 'x' }, signal: cancelled.signal })
    ).resolves.toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('stops a handler result from being reported as successful after cancellation', async () => {
    let finish!: (value: string) => void;
    const handler = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    const registry = createCodexDynamicToolRegistry({
      jupyter: {
        type: 'inline',
        name: 'jupyter',
        version: '1.0.0',
        tools: [
          { name: 'execute', description: 'Execute a cell', parameters: z.object({}), handler },
        ],
      },
    });
    const controller = new AbortController();
    const result = registry.call({
      requestId: 1,
      callId: 'call-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      namespace: 'jupyter',
      tool: 'execute',
      arguments: {},
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    controller.abort();
    finish('late result');
    await expect(result).resolves.toMatchObject({
      success: false,
      contentItems: [expect.objectContaining({ type: 'inputText' })],
    });
  });

  it('rejects stdio and duplicate inline namespaces before exposing a partial registry', () => {
    expect(() =>
      createCodexDynamicToolRegistry({
        local: { type: 'stdio', name: 'local', command: 'node' },
      })
    ).toThrow(/do not support stdio/);
    expect(() =>
      createCodexDynamicToolRegistry({
        first: { name: 'jupyter', version: '1.0.0', tools: [] } as unknown as McpServerConfig,
        second: { name: 'jupyter', version: '1.0.0', tools: [] } as unknown as McpServerConfig,
      })
    ).toThrow(/namespace "jupyter" is duplicated/);
  });
});
