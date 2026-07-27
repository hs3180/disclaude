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

/**
 * Structural mirror of pi's `AgentToolResult` (the value execute resolves to).
 * `result` carries the success value; `isError: true` marks a controlled
 * failure (param validation, handler error, abort).
 */
export interface PiAgentToolResult {
  result?: unknown;
  isError?: boolean;
  /** Optional progress/error details. */
  details?: unknown;
}

/** Structural mirror of pi's per-turn update callback (progress reports). */
export type PiAgentToolUpdateCallback = (details: unknown) => void;

/**
 * Structural mirror of pi's `AgentHarnessTool` — only the fields this adapter
 * produces. The real type is generic over a `TContext`; we leave it untyped
 * here (the adapter does not consume the context).
 */
export interface PiAgentHarnessTool {
  name: string;
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
 * Adapt a disclaude `InlineToolDefinition` into a pi `AgentHarnessTool` shape.
 *
 * The execute wrapper:
 * 1. Honors an already-aborted signal (returns `{ isError: true }`).
 * 2. Validates `params` through the disclaude Zod schema (authoritative).
 * 3. Invokes the disclaude handler with the parsed params.
 * 4. Shapes the return value as a pi `AgentToolResult`.
 *
 * Param-validation failures and handler errors are returned as
 * `{ isError: true, result: <message> }` rather than thrown, so pi's tool
 * dispatch always receives a result (a thrown error from a tool's execute
 * would surface as an unhandled tool-call failure rather than a tool result).
 */
export function adaptInlineTool(
  definition: InlineToolDefinition,
): PiAgentHarnessTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: { type: 'object', additionalProperties: true },

    execute: async (_toolCallId, params, signal, _onUpdate, _context) => {
      if (signal?.aborted) {
        return { isError: true, result: 'aborted before execution' };
      }
      try {
        // Authoritative param validation via the disclaude Zod schema.
        const parsed = definition.parameters.parse(params);
        const result = await definition.handler(parsed);
        return { result };
      } catch (error) {
        return {
          isError: true,
          result: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
