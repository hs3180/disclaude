import { describe, expect, it, vi } from 'vitest';
import { prepareTools, assertToolOptions, type ToolDefinition } from './tools.js';

function definition(
  execute = vi.fn<ToolDefinition['execute']>().mockResolvedValue({ value: 42 })
): ToolDefinition {
  return {
    name: 'read_value',
    description: 'Read a value',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', minLength: 1 } },
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
const context = () => ({ signal: new AbortController().signal });

describe('host tool contract', () => {
  it.each(['nativeTools', 'hostTools', 'builtinTools', 'mcpServers'])(
    'rejects retired query option %s for JavaScript callers',
    (name) => {
      expect(() => assertToolOptions({ [name]: [] })).toThrow('no longer a query option');
    }
  );
  it('accepts definitions and rejects tool names or presets in the business entry', () => {
    expect(() => assertToolOptions({ tools: [definition()] })).not.toThrow();
    expect(() => assertToolOptions({ tools: [] })).not.toThrow();
    expect(() => assertToolOptions({ tools: ['read'] })).toThrow('ToolDefinition');
    expect(() => assertToolOptions({ tools: { type: 'preset', preset: 'claude_code' } })).toThrow(
      'ToolDefinition'
    );
  });
  it('preserves inputs/results and isolates declarations from subsequent caller mutation', async () => {
    const source = definition();
    const [prepared] = prepareTools([source]);
    (source.inputSchema.properties as Record<string, unknown>).key = { type: 'number' };
    const args = { key: 'answer' };
    const ctx = context();
    await expect(prepared.execute(args, ctx)).resolves.toEqual({ value: 42 });
    expect(source.execute).toHaveBeenCalledWith(args, ctx);
    expect(args).toEqual({ key: 'answer' });
    await expect(prepared.execute({ key: 42 }, ctx)).rejects.toThrow('Invalid host tool arguments');
  });

  it.each([{ key: '' }, { key: 42 }, {}, { key: 'answer', extra: true }, []])(
    'rejects invalid arguments without invoking or modifying the callback',
    async (args) => {
      const source = definition();
      const before = JSON.stringify(args);
      await expect(
        prepareTools([source])[0].execute(args as Record<string, unknown>, context())
      ).rejects.toThrow('Invalid host tool arguments');
      expect(source.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(args)).toBe(before);
    }
  );

  it.each([
    { value: '42' },
    { value: undefined },
    { value: Infinity },
    { value: 42, dropped: undefined },
    new Date(),
  ])('rejects invalid or non-JSON results', async (value) => {
    const source = definition(vi.fn().mockResolvedValue(value));
    await expect(prepareTools([source])[0].execute({ key: 'answer' }, context())).rejects.toThrow();
  });

  it('checks cancellation before dispatch and after owned work settles', async () => {
    const abort = new AbortController();
    const source = definition(
      vi.fn(() => {
        abort.abort();
        return Promise.resolve({ value: 42 });
      })
    );
    const [tool] = prepareTools([source]);
    await expect(tool.execute({ key: 'answer' }, { signal: abort.signal })).rejects.toThrow();
    await expect(tool.execute({ key: 'answer' }, { signal: abort.signal })).rejects.toThrow();
    expect(source.execute).toHaveBeenCalledOnce();
  });

  it('rejects duplicate names, non-object input schemas and unsupported schema constraints', () => {
    const source = definition();
    expect(() => prepareTools([source, source])).toThrow('duplicate');
    expect(() => prepareTools([{ ...source, name: 'Bad-name' }])).toThrow('Invalid');
    expect(() => prepareTools([{ ...source, inputSchema: { type: 'string' } }])).toThrow(
      'Invalid host tool definition'
    );
    expect(() =>
      prepareTools([{ ...source, inputSchema: { type: 'object', unknownConstraint: true } }])
    ).toThrow();
  });

  it.each(['allowedTools', 'disallowedTools'])(
    'rejects the Claude-only %s field at a common query boundary',
    (field) => {
      expect(() => assertToolOptions({ [field]: [] })).toThrow('Claude-specific query option');
    }
  );
});
