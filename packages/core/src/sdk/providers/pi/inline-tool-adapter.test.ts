/**
 * Tests for the inline-tool adapter (Issue #4387 S4, parts 1 + 2).
 *
 * Uses a real Zod schema so param validation + schema translation are exercised
 * end-to-end. No pi runtime — the adapter is a pure wrapper.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { adaptInlineTool } from './inline-tool-adapter.js';
import type { InlineToolDefinition, ToolProgressPayload } from '../../types.js';

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
    // #4568: the handler now receives the (here undefined) onProgress second
    // argument alongside the parsed params.
    expect(handler).toHaveBeenCalledWith({ q: 'pi.dev' }, undefined);
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

  describe('progress plumbing (Issue #4568: onUpdate → tool_execution_update)', () => {
    it('forwards handler onProgress calls to onUpdate as AgentToolResult shapes', async () => {
      // A long-running handler reports intermediate progress via its optional
      // second argument; each report must reach pi's onUpdate as the SAME
      // { content, details } shape the terminal result uses (that is what
      // pi's loop reads to emit `tool_execution_update`).
      const updates: unknown[] = [];
      const handler = vi.fn(
        (params: { q: string }, onProgress?: (p: ToolProgressPayload) => void) =>
          new Promise<string>((resolve) => {
            onProgress?.(`halfway through ${params.q}`);
            onProgress?.({ done: 2, total: 4 });
            resolve('finished');
          })
      );
      const tool = adaptInlineTool({ ...makeTool(), handler } as unknown as InlineToolDefinition);
      const res = await tool.execute(
        'call_1',
        { q: 'pi.dev' },
        undefined,
        (partial) => updates.push(partial),
        undefined
      );

      expect(updates).toEqual([
        {
          content: [{ type: 'text', text: 'halfway through pi.dev' }],
          details: 'halfway through pi.dev',
        },
        {
          content: [{ type: 'text', text: '{"done":2,"total":4}' }],
          details: { done: 2, total: 4 },
        },
      ]);
      // The handler received the wrapped onProgress as its second argument.
      expect(handler).toHaveBeenCalledWith({ q: 'pi.dev' }, expect.any(Function));
      // The terminal result is unaffected by progress reporting.
      expect(res.content).toEqual([{ type: 'text', text: 'finished' }]);
      expect(res.details).toBe('finished');
    });

    it('passes undefined onProgress when pi supplies no onUpdate (pre-#4568 behavior)', async () => {
      // pi always hands execute an onUpdate today, but the adapter must not
      // REQUIRE it: a bare execute call (as in these tests) leaves the
      // handler's second argument undefined — handlers that ignore progress
      // are unaffected.
      const handler = vi.fn(() => Promise.resolve('ok'));
      const tool = adaptInlineTool({ ...makeTool(), handler } as unknown as InlineToolDefinition);
      const res = await tool.execute('call_1', { q: 'x' }, undefined, undefined, undefined);
      expect(handler).toHaveBeenCalledWith({ q: 'x' }, undefined);
      expect(res.details).toBe('ok');
    });

    it('swallows an onUpdate throw so progress cannot fail the tool execution', async () => {
      // pi rejecting an update (e.g. after the run settled) must surface in
      // the event stream, not as a failed tool call — the reply would be
      // lost. The handler still completes and its result is returned.
      const handler = vi.fn(
        (_params: { q: string }, onProgress?: (p: ToolProgressPayload) => void) =>
          new Promise<string>((resolve) => {
            onProgress?.('step 1'); // throws inside onUpdate — must be swallowed
            resolve('done anyway');
          })
      );
      const tool = adaptInlineTool({ ...makeTool(), handler } as unknown as InlineToolDefinition);
      const res = await tool.execute(
        'call_1',
        { q: 'x' },
        undefined,
        () => {
          throw new Error('update rejected');
        },
        undefined
      );
      expect(res.content).toEqual([{ type: 'text', text: 'done anyway' }]);
    });

    it('round-trips every ToolProgressPayload shape through onUpdate verbatim (type test)', async () => {
      // #4568 type follow-up: the structured payload shapes ({message, percent?},
      // {done, total?, message?}, plain string) must all be assignable to the
      // handler's onProgress and reach onUpdate with their details preserved —
      // the adapter adds no validation or normalization on purpose.
      const updates: unknown[] = [];
      const payloads: ToolProgressPayload[] = [
        { message: 'crawling page 3', percent: 30 },
        { done: 2, total: 4 },
        { done: 7 }, // total unknown — heartbeat + counter
        'plain string passes through',
      ];
      const handler = vi.fn(
        (_params: { q: string }, onProgress?: (p: ToolProgressPayload) => void) =>
          new Promise<string>((resolve) => {
            for (const p of payloads) {
              onProgress?.(p);
            }
            resolve('ok');
          })
      );
      const tool = adaptInlineTool({ ...makeTool(), handler } as unknown as InlineToolDefinition);
      await tool.execute(
        'call_1',
        { q: 'x' },
        undefined,
        (partial) => updates.push(partial),
        undefined
      );

      expect(updates.map((u) => (u as { details: unknown }).details)).toEqual(payloads);
      // Structured shapes serialize as model-readable JSON text in content.
      expect(updates[0]).toEqual({
        content: [{ type: 'text', text: '{"message":"crawling page 3","percent":30}' }],
        details: { message: 'crawling page 3', percent: 30 },
      });
    });
  });
});
