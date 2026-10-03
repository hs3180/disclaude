import { describe, expect, it, vi } from 'vitest';
import {
  prepareHostTools,
  selectHostTools,
  assertToolOptions,
  type HostToolDefinition,
} from './host-tools.js';

function definition(
  execute = vi.fn<HostToolDefinition['execute']>().mockResolvedValue({ value: 42 })
): HostToolDefinition {
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
  it('rejects retired query option names for JavaScript callers', () => {
    expect(() => assertToolOptions({ nativeTools: [] })).toThrow('replaced by hostTools');
    expect(() => assertToolOptions({ tools: [] })).toThrow('replaced by builtinTools');
    expect(() => assertToolOptions({ builtinTools: [], hostTools: [] })).not.toThrow();
  });
  it('preserves inputs/results and isolates declarations from subsequent caller mutation', async () => {
    const source = definition();
    const [prepared] = prepareHostTools([source]);
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
        prepareHostTools([source])[0].execute(args as Record<string, unknown>, context())
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
    await expect(
      prepareHostTools([source])[0].execute({ key: 'answer' }, context())
    ).rejects.toThrow();
  });

  it('checks cancellation before dispatch and after owned work settles', async () => {
    const abort = new AbortController();
    const source = definition(
      vi.fn(() => {
        abort.abort();
        return Promise.resolve({ value: 42 });
      })
    );
    const [tool] = prepareHostTools([source]);
    await expect(tool.execute({ key: 'answer' }, { signal: abort.signal })).rejects.toThrow();
    await expect(tool.execute({ key: 'answer' }, { signal: abort.signal })).rejects.toThrow();
    expect(source.execute).toHaveBeenCalledOnce();
  });

  it('rejects duplicate names, non-object input schemas and unsupported schema constraints', () => {
    const source = definition();
    expect(() => prepareHostTools([source, source])).toThrow('duplicate');
    expect(() => prepareHostTools([{ ...source, name: 'Bad-name' }])).toThrow('Invalid');
    expect(() => prepareHostTools([{ ...source, inputSchema: { type: 'string' } }])).toThrow(
      'Invalid host tool definition'
    );
    expect(() =>
      prepareHostTools([{ ...source, inputSchema: { type: 'object', unknownConstraint: true } }])
    ).toThrow();
  });

  it('treats an empty allowlist as deny-all and keeps builtinTools out of host permissions', () => {
    const tools = prepareHostTools([definition()]);
    expect(selectHostTools(tools, {})).toHaveLength(1);
    expect(selectHostTools(tools, { allowedTools: [] })).toEqual([]);
    expect(
      selectHostTools(tools, { allowedTools: ['read_value'], disallowedTools: ['read_value'] })
    ).toEqual([]);
  });
});
