import { describe, expect, it, vi } from 'vitest';
import type { NativeAgentTool } from '../../native-tools.js';
import { registerDshNativeTools, type DshNativeToolRegistry } from './native-tools.js';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

function context(signal: AbortSignal): ToolRunContext {
  return {
    signal,
    callId: 'call-1' as ToolRunContext['callId'],
    rootCallId: 'call-1' as ToolRunContext['rootCallId'],
    token: Symbol('native-test') as ToolRunContext['token'],
    name: 'notebook_read_cell',
    arguments: {},
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
  };
}

function tool(name = 'notebook_read_cell'): NativeAgentTool {
  return {
    name,
    description: 'Read current shared source',
    inputSchema: { type: 'object', properties: { cellId: { type: 'string' } } },
    outputSchema: { type: 'object' },
    execute: vi.fn().mockResolvedValue({ cellId: 'cell-1', revision: 'rev-2' }),
  };
}

describe('DSH native tool registration', () => {
  it('registers the canonical contract directly, preserving structured values and signal', async () => {
    const nativeTool = tool();
    const dispose = vi.fn();
    const register = vi.fn<DshNativeToolRegistry['register']>().mockReturnValue(dispose);
    const release = registerDshNativeTools({ register }, [nativeTool]);
    const [[definition]] = register.mock.calls;
    expect(definition.parameters).toBe(nativeTool.inputSchema);
    expect(definition.output.schema).toBe(nativeTool.outputSchema);
    const { signal } = new AbortController();
    const value = (await definition.execute({ cellId: 'cell-1' }, context(signal))) as {
      cellId: string;
      revision: string;
    };
    expect(nativeTool.execute).toHaveBeenCalledWith(
      { cellId: 'cell-1' },
      { signal, invocationId: 'call-1' }
    );
    expect(value).toEqual({ cellId: 'cell-1', revision: 'rev-2' });
    expect(definition.output.presentationMeta?.({}, value)).toBe(value);
    expect(definition.output.render({}, value)).toEqual([
      { type: 'text', text: '{"cellId":"cell-1","revision":"rev-2"}' },
    ]);
    release();
    release();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rolls back partial registration', () => {
    const dispose = vi.fn();
    const register = vi
      .fn<DshNativeToolRegistry['register']>()
      .mockReturnValueOnce(dispose)
      .mockImplementationOnce(() => {
        throw new Error('registry unavailable');
      });
    expect(() =>
      registerDshNativeTools({ register }, [tool('read_cell'), tool('edit_cell')])
    ).toThrow('registry unavailable');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid and duplicate names before mutating the registry', () => {
    const register = vi.fn();
    expect(() => registerDshNativeTools({ register }, [tool(), tool()])).toThrow('duplicate');
    expect(() => registerDshNativeTools({ register }, [tool('mcp__legacy-tool')])).toThrow(
      'Invalid'
    );
    expect(register).not.toHaveBeenCalled();
  });

  it('does not invoke business operations after caller cancellation', async () => {
    const nativeTool = tool();
    const register = vi.fn<DshNativeToolRegistry['register']>().mockReturnValue(() => {});
    registerDshNativeTools({ register }, [nativeTool]);
    const abort = new AbortController();
    abort.abort(new Error('human takeover'));
    await expect(register.mock.calls[0][0].execute({}, context(abort.signal))).rejects.toThrow(
      'human takeover'
    );
    expect(nativeTool.execute).not.toHaveBeenCalled();
  });
});
