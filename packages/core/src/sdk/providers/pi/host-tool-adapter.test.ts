import { describe, expect, it, vi } from 'vitest';
import type { HostToolDefinition } from '../../host-tools.js';
import { adaptPiHostTools } from './host-tool-adapter.js';

function definition(
  execute: HostToolDefinition['execute'] = ({ x }) => Promise.resolve({ doubled: Number(x) * 2 })
): HostToolDefinition {
  return {
    name: 'double',
    description: 'Double',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    execute,
  };
}

describe('Pi host tool adapter', () => {
  it('preserves model-facing schema and structured results', async () => {
    const execute = vi.fn<HostToolDefinition['execute']>().mockResolvedValue({ doubled: 42 });
    const source = definition(execute);
    const [tool] = adaptPiHostTools([source]);
    expect(tool.parameters).toEqual(source.inputSchema);
    const { signal } = new AbortController();
    await expect(tool.execute('call', { x: 21 }, signal, undefined, undefined)).resolves.toEqual({
      content: [{ type: 'text', text: '{"doubled":42}' }],
      details: { doubled: 42 },
    });
    expect(execute).toHaveBeenCalledWith({ x: 21 }, { signal, invocationId: 'call' });
  });

  it('enforces original schemas without coercion, defaults or dropped fields', async () => {
    const execute = vi.fn<HostToolDefinition['execute']>().mockResolvedValue({});
    const [tool] = adaptPiHostTools([definition(execute)]);
    for (const args of [{ x: '21' }, {}, { x: 21, extra: true }]) {
      await expect(tool.execute('call', args, undefined, undefined, undefined)).rejects.toThrow(
        'Invalid host tool arguments'
      );
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes the live abort signal to the host and rejects late success', async () => {
    const abort = new AbortController();
    const execute = vi.fn<HostToolDefinition['execute']>((_args, context) => {
      expect(context.signal).toBe(abort.signal);
      abort.abort();
      return Promise.resolve({});
    });
    const [tool] = adaptPiHostTools([definition(execute)]);
    await expect(
      tool.execute('call', { x: 1 }, abort.signal, undefined, undefined)
    ).rejects.toThrow();
    await expect(
      tool.execute('next', { x: 1 }, abort.signal, undefined, undefined)
    ).rejects.toThrow();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('bridges best-effort progress without losing the final result', async () => {
    const [tool] = adaptPiHostTools([
      definition((_args, context) => {
        context.onProgress?.({ percent: 50 });
        return Promise.resolve({ done: true });
      }),
    ]);
    const update = vi.fn().mockImplementationOnce(() => {
      throw new Error('observer closed');
    });
    await expect(
      tool.execute('call', { x: 1 }, undefined, update, undefined)
    ).resolves.toMatchObject({ details: { done: true } });
    expect(update).toHaveBeenCalledWith({
      content: [{ type: 'text', text: '{"percent":50}' }],
      details: { percent: 50 },
    });
  });

  it('keeps denied host callbacks out of the native registry', () => {
    const source = definition();
    expect(adaptPiHostTools([source], { allowedTools: [] })).toEqual([]);
    expect(adaptPiHostTools([source], { disallowedTools: ['double'] })).toEqual([]);
  });
});
