import { describe, expect, it, vi } from 'vitest';
import type { HostToolDefinition } from '../../host-tools.js';
import { registerDshHostTools, type DshHostToolRegistry } from './host-tool-adapter.js';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { createNotebookTools } from '../../../jupyter/notebook-tools.js';

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

function tool(name = 'notebook_read_cell'): HostToolDefinition {
  return {
    name,
    description: 'Read current shared source',
    inputSchema: { type: 'object', properties: { cellId: { type: 'string' } } },
    outputSchema: { type: 'object' },
    execute: vi.fn().mockResolvedValue({ cellId: 'cell-1', revision: 'rev-2' }),
  };
}

describe('DSH native tool registration', () => {
  it('registers the actual five Notebook tools with their shared schema constraints', async () => {
    const notebook = {
      identity: { connectionId: 'connection', serverNamespace: 'namespace', documentId: 'doc' },
      contentPath: 'test.ipynb',
    };
    const readCell = vi.fn().mockResolvedValue({
      notebook,
      cellId: 'cell',
      revision: 'revision',
      sourceHash: 'hash',
      source: 'print(1)',
    });
    const tools = createNotebookTools({
      notebook,
      documents: { readCell, editCellSource: vi.fn() },
      executions: { submit: vi.fn(), getStatus: vi.fn(), stop: vi.fn() },
      controller: () => Promise.resolve({ ownerId: 'owner', generation: 1 }),
      kernel: () => Promise.resolve({ kernelId: 'kernel', kernelIncarnation: 'incarnation' }),
    });
    const register = vi.fn<DshHostToolRegistry['register']>().mockReturnValue(() => {});
    registerDshHostTools({ register }, tools);
    expect(register.mock.calls.map(([definition]) => definition.name)).toEqual(
      tools.map((item) => item.name)
    );
    const [[read]] = register.mock.calls;
    const { signal } = new AbortController();
    await expect(read.execute({ cellId: '' }, context(signal))).rejects.toThrow(
      'Invalid host tool arguments'
    );
    expect(readCell).not.toHaveBeenCalled();
    await expect(read.execute({ cellId: 'cell' }, context(signal))).resolves.toMatchObject({
      notebook,
      sourceHash: 'hash',
      source: 'print(1)',
    });
    expect(readCell).toHaveBeenCalledWith(notebook, 'cell');
  });

  it('registers the canonical contract directly, preserving structured values and signal', async () => {
    const nativeTool = tool();
    const dispose = vi.fn();
    const register = vi.fn<DshHostToolRegistry['register']>().mockReturnValue(dispose);
    const release = registerDshHostTools({ register }, [nativeTool]);
    const [[definition]] = register.mock.calls;
    expect(definition.parameters).toEqual(nativeTool.inputSchema);
    expect(definition.output.schema).toEqual(nativeTool.outputSchema);
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
      .fn<DshHostToolRegistry['register']>()
      .mockReturnValueOnce(dispose)
      .mockImplementationOnce(() => {
        throw new Error('registry unavailable');
      });
    expect(() =>
      registerDshHostTools({ register }, [tool('read_cell'), tool('edit_cell')])
    ).toThrow('registry unavailable');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('maps string constraints to native declarations while enforcing the original input schema', async () => {
    const nativeTool: HostToolDefinition = {
      ...tool(),
      inputSchema: {
        type: 'object',
        properties: { cellId: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['cellId'],
        additionalProperties: false,
      },
    };
    const register = vi.fn<DshHostToolRegistry['register']>().mockReturnValue(() => {});
    registerDshHostTools({ register }, [nativeTool]);
    const [[definition]] = register.mock.calls;
    expect(definition.parameters).toMatchObject({
      properties: {
        cellId: { type: 'string', description: expect.stringContaining('minLength=1') },
      },
    });
    expect(definition.parameters).not.toMatchObject({ properties: { cellId: { minLength: 1 } } });
    expect(nativeTool.inputSchema).toMatchObject({ properties: { cellId: { minLength: 1 } } });
    const { signal } = new AbortController();
    await expect(definition.execute({ cellId: '' }, context(signal))).rejects.toThrow(
      'Invalid host tool arguments'
    );
    await expect(definition.execute({ cellId: 'x'.repeat(65) }, context(signal))).rejects.toThrow(
      'Invalid host tool arguments'
    );
    expect(nativeTool.execute).not.toHaveBeenCalled();
    await expect(definition.execute({ cellId: 'cell-1' }, context(signal))).resolves.toMatchObject({
      cellId: 'cell-1',
    });
  });

  it('enforces output constraints and rejects other unrepresentable native schema keywords', async () => {
    const nativeTool: HostToolDefinition = {
      ...tool(),
      outputSchema: {
        type: 'object',
        properties: { revision: { type: 'string', minLength: 10 } },
        required: ['revision'],
      },
    };
    const register = vi.fn<DshHostToolRegistry['register']>().mockReturnValue(() => {});
    registerDshHostTools({ register }, [nativeTool]);
    await expect(
      register.mock.calls[0][0].execute({ cellId: 'cell-1' }, context(new AbortController().signal))
    ).rejects.toThrow('Invalid host tool result');
    const unsupported: HostToolDefinition = {
      ...nativeTool,
      inputSchema: {
        type: 'object',
        properties: { cellId: { type: 'string', pattern: '^cell-' } },
      },
    };
    expect(() => registerDshHostTools({ register }, [unsupported])).toThrow(
      'not a supported keyword'
    );
  });

  it('rejects invalid and duplicate names before mutating the registry', () => {
    const register = vi.fn();
    expect(() => registerDshHostTools({ register }, [tool(), tool()])).toThrow('duplicate');
    expect(() => registerDshHostTools({ register }, [tool('mcp__legacy-tool')])).toThrow('Invalid');
    expect(register).not.toHaveBeenCalled();
  });

  it('does not invoke business operations after caller cancellation', async () => {
    const nativeTool = tool();
    const register = vi.fn<DshHostToolRegistry['register']>().mockReturnValue(() => {});
    registerDshHostTools({ register }, [nativeTool]);
    const abort = new AbortController();
    abort.abort(new Error('human takeover'));
    await expect(register.mock.calls[0][0].execute({}, context(abort.signal))).rejects.toThrow(
      'human takeover'
    );
    expect(nativeTool.execute).not.toHaveBeenCalled();
  });
});
