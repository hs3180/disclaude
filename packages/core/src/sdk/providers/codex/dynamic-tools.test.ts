import { describe, expect, it, vi } from 'vitest';
import type { HostToolDefinition } from '../../host-tools.js';
import { createCodexDynamicToolRegistry } from './dynamic-tools.js';

function tool(
  execute = vi.fn<HostToolDefinition['execute']>().mockResolvedValue({ documentId: 'doc-1' })
): HostToolDefinition {
  return {
    name: 'read_notebook',
    description: 'Read',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    execute,
  };
}
const request = () => ({
  requestId: 'rpc-1',
  callId: 'call-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  namespace: 'disclaude',
  tool: 'read_notebook',
  arguments: { path: 'research.ipynb' },
  signal: new AbortController().signal,
});

describe('Codex host tool adapter', () => {
  it('exposes canonical schemas and dispatches with cancellation and trace context', async () => {
    const definition = tool();
    const registry = createCodexDynamicToolRegistry([definition]);
    expect(registry.specs).toMatchObject([
      {
        type: 'namespace',
        name: 'disclaude',
        tools: [{ type: 'function', name: definition.name, inputSchema: definition.inputSchema }],
      },
    ]);
    const call = request();
    await expect(registry.call(call)).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"documentId":"doc-1"}' }],
    });
    expect(definition.execute).toHaveBeenCalledWith(call.arguments, {
      signal: call.signal,
      invocationId: call.callId,
      identity: {
        provider: 'codex-app-server',
        requestId: call.requestId,
        callId: call.callId,
        threadId: call.threadId,
        turnId: call.turnId,
      },
    });
  });

  it('rejects invalid arguments, wrong namespaces, unknown names and cancelled calls', async () => {
    const definition = tool();
    const registry = createCodexDynamicToolRegistry([definition]);
    for (const patch of [
      { arguments: { path: '' } },
      { arguments: { path: 42 } },
      { namespace: 'jupyter' },
      { tool: 'missing' },
      { signal: AbortSignal.abort() },
    ]) {
      await expect(registry.call({ ...request(), ...patch })).resolves.toMatchObject({
        success: false,
      });
    }
    expect(definition.execute).not.toHaveBeenCalled();
  });

  it('waits for running host work but rejects its result after cancellation', async () => {
    let finish!: (value: unknown) => void;
    const execute = vi.fn<HostToolDefinition['execute']>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const registry = createCodexDynamicToolRegistry([tool(execute)]);
    const abort = new AbortController();
    const pending = registry.call({ ...request(), signal: abort.signal });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    abort.abort();
    finish({ documentId: 'late' });
    await expect(pending).resolves.toMatchObject({ success: false });
  });

  it('filters canonical tool names and cannot dispatch a denied tool', async () => {
    const definition = tool();
    for (const permissions of [{ allowedTools: [] }, { disallowedTools: [definition.name] }]) {
      const registry = createCodexDynamicToolRegistry([definition], permissions);
      expect(registry.specs).toEqual([]);
      await expect(registry.call(request())).resolves.toMatchObject({ success: false });
    }
    expect(definition.execute).not.toHaveBeenCalled();
  });

  it('reports invalid output and duplicate names before creating a partial registry', async () => {
    const definition = tool(vi.fn().mockResolvedValue('invalid object'));
    await expect(
      createCodexDynamicToolRegistry([definition]).call(request())
    ).resolves.toMatchObject({ success: false });
    expect(() => createCodexDynamicToolRegistry([definition, definition])).toThrow('duplicate');
  });
});
