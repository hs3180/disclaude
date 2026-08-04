/**
 * Tests for the inline-tool adapter (Issue #4387 S4, parts 1 + 2).
 *
 * Uses a real Zod schema so param validation + schema translation are exercised
 * end-to-end. No pi runtime — the adapter is a pure wrapper.
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
  it('mirrors name + description and derives a label for pi UI display', () => {
    const tool = adaptInlineTool(makeTool());
    expect(tool.name).toBe('search');
    expect(tool.description).toBe('Search the web');
    // InlineToolDefinition has no label field — derived from name.
    expect(tool.label).toBe('search');
  });

  it('translates the Zod object schema so the model sees the real param shape', () => {
    // makeTool uses z.object({ q: z.string() }) — part 2 turns this into the
    // JSON-Schema shape TypeBox would serialize, instead of the permissive
    // placeholder used in part 1.
    const tool = adaptInlineTool(makeTool());
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    });
  });

  describe('parameters schema translation (part 2: Zod → JSON Schema)', () => {
    // `z.toJSONSchema` adds a document-root `$schema` annotation that the
    // adapter strips (a tool input schema is nested, not a standalone doc).
    function parametersOf(parameters: InlineToolDefinition['parameters']) {
      return adaptInlineTool({
        ...makeTool(),
        parameters,
      } as unknown as InlineToolDefinition).parameters;
    }

    it('strips the z.toJSONSchema document-root $schema annotation', () => {
      // Sanity: no `$schema` leaks into the model-facing tool schema.
      expect(parametersOf(z.object({ q: z.string() }))).not.toHaveProperty('$schema');
    });

    it('translates string / number / boolean primitives', () => {
      const p = parametersOf(z.object({ s: z.string(), n: z.number(), b: z.boolean() }));
      expect(p.properties).toMatchObject({
        s: { type: 'string' },
        n: { type: 'number' },
        b: { type: 'boolean' },
      });
    });

    it('translates arrays via `items`', () => {
      const p = parametersOf(z.object({ tags: z.array(z.string()) }));
      expect(p.properties).toMatchObject({
        tags: { type: 'array', items: { type: 'string' } },
      });
    });

    it('translates nested objects (properties + required + strict)', () => {
      const p = parametersOf(z.object({ meta: z.object({ x: z.number() }) }));
      expect(p.properties).toMatchObject({
        meta: {
          type: 'object',
          properties: { x: { type: 'number' } },
          required: ['x'],
          additionalProperties: false,
        },
      });
    });

    it('translates enums (zod enum → string + enum values)', () => {
      const p = parametersOf(z.object({ color: z.enum(['red', 'green', 'blue']) }));
      expect(p.properties).toMatchObject({
        color: { type: 'string', enum: ['red', 'green', 'blue'] },
      });
    });

    it('lists required fields and omits optional ones', () => {
      const p = parametersOf(z.object({ req: z.string(), opt: z.string().optional() }));
      expect(p.required).toEqual(['req']);
    });
  });

  it('falls back to the permissive placeholder when Zod cannot serialize the schema', () => {
    // A non-Zod parameters object (as used by provider.test.ts's minimal stub)
    // cannot be translated — the adapter must not crash, and execute still
    // validates inputs at runtime.
    const tool = adaptInlineTool({
      ...makeTool(),
      parameters: { parse: (p: unknown) => p } as never,
    } as unknown as InlineToolDefinition);
    expect(tool.parameters).toEqual({ type: 'object', additionalProperties: true });
  });

  it('validates params via Zod and returns a pi AgentToolResult shape', async () => {
    const handler = vi.fn(({ q }: { q: string }) => Promise.resolve(`results for ${q}`));
    const tool = adaptInlineTool({ ...makeTool(), handler } as unknown as InlineToolDefinition);
    const res = await tool.execute('call_1', { q: 'pi.dev' }, undefined, undefined, undefined);

    // Success value flows to the two fields pi's agent loop reads: the
    // model-facing `content[0].text` and the structured `details`.
    expect(res.content).toEqual([{ type: 'text', text: 'results for pi.dev' }]);
    expect(res.details).toBe('results for pi.dev');
    expect(handler).toHaveBeenCalledWith({ q: 'pi.dev' });
  });

  it('JSON-stringifies non-string handler results into the content text', async () => {
    const tool = adaptInlineTool({
      ...makeTool(),
      handler: vi.fn(() => Promise.resolve({ hits: 3 })),
    } as unknown as InlineToolDefinition);
    const res = await tool.execute('call_1', { q: 'x' }, undefined, undefined, undefined);

    expect(res.content[0]).toMatchObject({ type: 'text', text: '{"hits":3}' });
    expect(res.details).toEqual({ hits: 3 });
  });

  it('throws on Zod validation failure (pi converts to an isError result)', async () => {
    const handler = vi.fn(() => Promise.resolve('should not reach'));
    const tool = adaptInlineTool({ ...makeTool(), handler } as unknown as InlineToolDefinition);
    // q is required — passing a wrong shape must fail validation.
    await expect(
      tool.execute('call_1', { wrong: 1 }, undefined, undefined, undefined)
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('re-throws when the handler throws (pi converts to an isError result)', async () => {
    const tool = adaptInlineTool({
      ...makeTool(),
      handler: vi.fn(() => Promise.reject(new Error('boom'))),
    } as unknown as InlineToolDefinition);
    await expect(
      tool.execute('call_1', { q: 'x' }, undefined, undefined, undefined)
    ).rejects.toThrow('boom');
  });

  it('honors an already-aborted signal (handler not called)', async () => {
    const handler = vi.fn(() => Promise.resolve('should not reach'));
    const tool = adaptInlineTool({ ...makeTool(), handler } as unknown as InlineToolDefinition);
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute('call_1', { q: 'x' }, controller.signal, undefined, undefined)
    ).rejects.toThrow(/aborted/i);
    expect(handler).not.toHaveBeenCalled();
  });
});
