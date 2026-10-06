import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../tools.js';
import { createCodexDynamicToolRegistry } from './dynamic-tools.js';

function tool(
  execute = vi.fn<ToolDefinition['execute']>().mockResolvedValue({ documentId: 'doc-1' })
): ToolDefinition {
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
  it('renders canonical tool images as app-server inputImage without base64 text', async () => {
    const data = Buffer.from('png bytes').toString('base64');
    const registry = createCodexDynamicToolRegistry([
      tool(
        vi
          .fn()
          .mockResolvedValue({
            format: 'disclaude.tool-result.v1',
            data: { cellId: 'plot' },
            images: [{ mimeType: 'image/png', data }],
          })
      ),
    ]);
    expect(await registry.call(request())).toEqual({
      success: true,
      contentItems: [
        { type: 'inputText', text: '{"cellId":"plot"}' },
        { type: 'inputImage', imageUrl: `data:image/png;base64,${data}` },
      ],
    });
  });

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
    const execute = vi.fn<ToolDefinition['execute']>(
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

  it('reports invalid output and duplicate names before creating a partial registry', async () => {
    const definition = tool(vi.fn().mockResolvedValue('invalid object'));
    await expect(
      createCodexDynamicToolRegistry([definition]).call(request())
    ).resolves.toMatchObject({ success: false });
    expect(() => createCodexDynamicToolRegistry([definition, definition])).toThrow('duplicate');
  });
});
