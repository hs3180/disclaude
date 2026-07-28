/**
 * disclaude `InlineToolDefinition` → pi-agent-core `AgentHarnessTool` adapter.
 *
 * Issue #4387 (S4, part 1): the inline-tool bridge. disclaude tools are
 * { name, description, parameters: ZodSchema, handler(params) }; pi tools are
 * TypeBox (`TSchema`) + a richer `execute(toolCallId, params, signal, onUpdate,
 * context)` signature. This adapter wraps a disclaude tool so pi can invoke it.
 *
 * Source of truth for the pi side: #4384 spike findings
 * (`docs/pi-agent-core-api-research.md` §3) against
 * @earendil-works/pi-agent-core@0.82.1. The pi types below are a STRUCTURAL
 * MIRROR (cf. event-adapter.ts, #4386) — disclaude takes no hard dependency on
 * pi-agent-core; re-verify on a pi version bump.
 *
 * Part-1 scope: the execute wrapper (Zod param validation → handler →
 * `AgentToolResult` shaping, with abort handling). The Zod→TypeBox parameter
 * SCHEMA translation is deferred to part 2 — until it lands, `parameters` is a
 * permissive placeholder, so the model does not see the real param shape
 * (execute still validates inputs through Zod at runtime).
 */

import type { InlineToolDefinition } from '../../types.js';

/** Mirror of pi's `TextContent` (`{ type: 'text', text }`). */
export interface PiTextContent {
  type: 'text';
  text: string;
  textSignature?: string;
}

/** Mirror of pi's `ImageContent` (`{ type: 'image', data, mimeType }`). */
export interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/**
 * Structural mirror of pi's `AgentToolResult<T>` (the value execute resolves
 * to). pi's agent loop reads `content` (model-facing text/image) and `details`
 * (structured payload for logs/UI) when building the tool-result message; the
 * optional `usage` / `addedToolNames` / `terminate` fields are omitted because
 * this adapter does not produce them.
 */
export interface PiAgentToolResult {
  content: (PiTextContent | PiImageContent)[];
  details: unknown;
}

/** Structural mirror of pi's `AgentToolUpdateCallback` (progress reports). */
export type PiAgentToolUpdateCallback = (partialResult: PiAgentToolResult) => void;

/**
 * Structural mirror of pi's `AgentHarnessTool` — only the fields this adapter
 * produces. The real type is generic over a `TContext`; we leave it untyped
 * here (the adapter does not consume the context). `label` is required by pi's
 * `AgentTool` for UI display; disclaude's `InlineToolDefinition` has no label
 * field, so it is derived from `name` until a dedicated field is added.
 */
export interface PiAgentHarnessTool {
  name: string;
  label: string;
  description: string;
  /**
   * Permissive placeholder schema. Part 2 will translate the disclaude Zod
   * schema to TypeBox so the model sees the real parameter shape.
   */
  parameters: { type: 'object'; additionalProperties: true };
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: PiAgentToolUpdateCallback | undefined,
    context: unknown,
  ) => Promise<PiAgentToolResult>;
}

/**
 * Render a handler result as the model-facing content array: strings pass
 * through verbatim, everything else is JSON-stringified. `JSON.stringify`
 * returns `undefined` only for `undefined` input, which we normalize to
 * `'null'` so `text` is always a string (as `TextContent` requires).
 */
function toContent(result: unknown): (PiTextContent | PiImageContent)[] {
  const text =
    typeof result === 'string' ? result : (JSON.stringify(result) ?? 'null');
  return [{ type: 'text', text }];
}

/**
 * Adapt a disclaude `InlineToolDefinition` into a pi `AgentHarnessTool` shape.
 *
 * The execute wrapper:
 * 1. Honors an already-aborted signal (throws).
 * 2. Validates `params` through the disclaude Zod schema (authoritative).
 * 3. Invokes the disclaude handler with the parsed params.
 * 4. Shapes the success value as a pi `AgentToolResult` (`content` +
 *    `details`).
 *
 * Per pi's `AgentTool.execute` contract, failures (abort, param-validation
 * errors, handler errors) are THROWN rather than encoded in `content`: pi's
 * agent loop catches a thrown execute error and synthesizes an `isError` tool
 * result from the message (see `executePreparedToolCall` in pi-agent-core).
 * Keeping the success return always in the `{ content, details }` shape is what
 * lets the model consume tool output correctly.
 */
export function adaptInlineTool(
  definition: InlineToolDefinition,
): PiAgentHarnessTool {
  return {
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: { type: 'object', additionalProperties: true },

    execute: async (_toolCallId, params, signal, _onUpdate, _context) => {
      if (signal?.aborted) {
        throw new Error('aborted before execution');
      }
      // Authoritative param validation via the disclaude Zod schema.
      // Throws on invalid input — pi converts to an isError tool result.
      const parsed = definition.parameters.parse(params);
      const result = await definition.handler(parsed);
      return { content: toContent(result), details: result };
    },
  };
}
