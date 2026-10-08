import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolDefinition } from '../../tools.js';
import { adaptOptions } from './options-adapter.js';
import { createClaudeToolServer } from './tool-adapter.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function connect(
  definitions: ToolDefinition[],
  permissions: { allowedTools?: string[]; disallowedTools?: string[] } = {}
) {
  const handle = createClaudeToolServer(definitions, permissions);
  const client = new Client({ name: 'host-tool-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.instance.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await handle.instance.close();
  });
  return client;
}

function definition(
  execute = vi.fn<ToolDefinition['execute']>().mockResolvedValue({ value: 42 })
): ToolDefinition {
  return {
    name: 'read_value',
    description: 'Read',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', minLength: 1, pattern: '^cell-' } },
      required: ['key'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
      additionalProperties: false,
    },
    execute,
  };
}

describe('Claude host tool adapter over real MCP transport', () => {
  it('renders image content through native MCP without encoded bytes in text', async () => {
    const data = Buffer.from('png bytes').toString('base64');
    const source = {
      ...definition(),
      outputSchema: { type: 'object' },
      execute: () =>
        Promise.resolve({
          format: 'disclaude.tool-result.v1',
          data: { cellId: 'plot' },
          images: [{ mimeType: 'image/png', data }],
        }),
    };
    const client = await connect([source]);
    expect(
      await client.callTool({ name: source.name, arguments: { key: 'cell-1' } })
    ).toMatchObject({
      content: [
        { type: 'text', text: '{"cellId":"plot"}' },
        { type: 'image', mimeType: 'image/png', data },
      ],
    });
  });

  it('preserves full schemas and returns model text plus structured content', async () => {
    const source = definition();
    const client = await connect([source]);
    const { tools } = await client.listTools();
    expect(tools).toMatchObject([
      { name: source.name, inputSchema: source.inputSchema, outputSchema: source.outputSchema },
    ]);
    await expect(
      client.callTool({ name: source.name, arguments: { key: 'cell-1' } })
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: '{"value":42}' }],
      structuredContent: { value: 42 },
    });
    expect(source.execute).toHaveBeenCalledWith(
      { key: 'cell-1' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('enforces original constraints, rejects denied and unknown calls, and checks outputs', async () => {
    const source = definition();
    const client = await connect([source]);
    for (const args of [
      { key: '' },
      { key: 'wrong-prefix' },
      { key: 42 },
      { key: 'cell-1', extra: true },
    ]) {
      await expect(client.callTool({ name: source.name, arguments: args })).resolves.toMatchObject({
        isError: true,
      });
    }
    expect(source.execute).not.toHaveBeenCalled();
    const denied = await connect([source], { disallowedTools: [source.name] });
    expect((await denied.listTools()).tools).toEqual([]);
    await expect(
      denied.callTool({ name: source.name, arguments: { key: 'cell-1' } })
    ).resolves.toMatchObject({ isError: true });
    const invalid = await connect([definition(vi.fn().mockResolvedValue({ value: 'wrong' }))]);
    await expect(
      invalid.callTool({ name: source.name, arguments: { key: 'cell-1' } })
    ).resolves.toMatchObject({ isError: true });
  });

  it('passes native request cancellation to running host work', async () => {
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const source = definition(
      vi.fn(async (_args, context) => {
        ({ signal } = context);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { value: 42 };
      })
    );
    const client = await connect([source]);
    const abort = new AbortController();
    const pending = client.callTool(
      { name: source.name, arguments: { key: 'cell-1' } },
      undefined,
      { signal: abort.signal }
    );
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(signal).toBeDefined());
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    finish();
  });

  it('owns built-in defaults and MCP wrapping while accepting canonical permissions', () => {
    const source = definition();
    const options = adaptOptions(
      {
        settingSources: [],
        tools: [source],
      },
      {
        allowedTools: ['Read', source.name],
      }
    );
    expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(options.allowedTools).toEqual(['Read', 'mcp__disclaude__read_value']);
    expect(Object.keys(options.mcpServers as object)).toEqual(['disclaude']);
    expect(options.mcpServers).toMatchObject({ disclaude: { type: 'sdk', name: 'disclaude' } });
    expect(() =>
      adaptOptions({ settingSources: [], ...({ mcpServers: {} } as Record<string, unknown>) })
    ).toThrow('no longer a query option');
  });
});
