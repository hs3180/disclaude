/**
 * Tests for the inline-tool adapter (Issue #4387 S4, part 1).
 *
 * Uses a real Zod schema so param validation is exercised end-to-end. No pi
 * runtime — the adapter is a pure wrapper.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { adaptInlineTool } from './inline-tool-adapter.js';
import type { InlineToolDefinition } from '../../types.js';

function makeTool(overrides: Partial<InlineToolDefinition> = {}): InlineToolDefinition {
  return {
    name: 'search',
    description: 'Search the web',
    parameters: z.object({ q: z.string() }),
    handler: vi.fn(({ q }: { q: string }) => Promise.resolve(`results for ${q}`)),
    ...overrides,
  } as unknown as InlineToolDefinition;
}

describe('adaptInlineTool (Issue #4387 / #4384)', () => {
  it('mirrors name + description from the disclaude definition', () => {
    const tool = adaptInlineTool(makeTool());
    expect(tool.name).toBe('search');
    expect(tool.description).toBe('Search the web');
  });

  it('emits a permissive placeholder schema (Zod→TypeBox deferred to part 2)', () => {
    const tool = adaptInlineTool(makeTool());
    expect(tool.parameters).toEqual({ type: 'object', additionalProperties: true });
  });

  it('validates params via Zod and invokes the handler with parsed input', async () => {
    const handler = vi.fn(({ q }: { q: string }) => Promise.resolve(`results for ${q}`));
    const tool = adaptInlineTool({ ...makeTool(), handler } as unknown as InlineToolDefinition);
    const res = await tool.execute('call_1', { q: 'pi.dev' }, undefined, undefined, undefined);

    expect(res).toEqual({ result: 'results for pi.dev' });
    expect(handler).toHaveBeenCalledWith({ q: 'pi.dev' });
  });

  it('returns isError on Zod validation failure (does not throw)', async () => {
    const handler = vi.fn(() => Promise.resolve('should not reach'));
    const tool = adaptInlineTool({ ...makeTool(), handler } as unknown as InlineToolDefinition);
    // q is required — passing a wrong shape must fail validation.
    const res = await tool.execute('call_1', { wrong: 1 }, undefined, undefined, undefined);

    expect(res.isError).toBe(true);
    expect(typeof res.result).toBe('string'); // the Zod error message
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns isError when the handler throws', async () => {
    const tool = adaptInlineTool({
      ...makeTool(),
      handler: vi.fn(() => Promise.reject(new Error('boom'))),
    } as unknown as InlineToolDefinition);
    const res = await tool.execute('call_1', { q: 'x' }, undefined, undefined, undefined);

    expect(res).toEqual({ isError: true, result: 'boom' });
  });

  it('honors an already-aborted signal (handler not called)', async () => {
    const handler = vi.fn(() => Promise.resolve('should not reach'));
    const tool = adaptInlineTool({ ...makeTool(), handler } as unknown as InlineToolDefinition);
    const controller = new AbortController();
    controller.abort();
    const res = await tool.execute('call_1', { q: 'x' }, controller.signal, undefined, undefined);

    expect(res.isError).toBe(true);
    expect(res.result).toMatch(/aborted/i);
    expect(handler).not.toHaveBeenCalled();
  });
});
