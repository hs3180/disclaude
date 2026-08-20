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
 * `AgentToolResult` shaping, with abort handling).
 *
 * Part-2 scope: the Zod→JSON-Schema parameter translation. pi tools use TypeBox
 * (`TSchema`) parameter schemas; TypeBox serializes to JSON Schema, so the
 * adapter emits a JSON-Schema-shaped object (via Zod's own `z.toJSONSchema`)
 * rather than taking a hard dependency on @sinclair/typebox — consistent with
 * the structural-mirror approach used for the rest of pi's types here. The
 * model now sees the real parameter shape; execute still validates inputs
 * authoritatively through Zod at runtime.
 *
 * #4389 scope (S6, part 1): the permission gate. pi has no built-in permission
 * system, and this adapter is the pi backend's ONLY tool injection point (the
 * 2026-08-07 MCP-removal decision) — so `adaptInlineTool` routes every
 * `execute` through a disclaude-owned `PiPermissionGate` BEFORE the tool
 * handler runs (permission-gate.ts). A deny throws with the gate's reason; pi
 * converts the throw into an isError tool result the model can react to.
 */

import { z } from 'zod';
import type { InlineToolDefinition } from '../../types.js';
import { ALLOW_ALL_GATE, type PiPermissionGate } from './permission-gate.js';

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
 * JSON-Schema-shaped parameter schema — what TypeBox's `TSchema` serializes to
 * and what the model receives as the tool's input schema. Mirrored structurally
 * (no hard @sinclair/typebox dependency); produced by translating the disclaude
 * Zod schema via `z.toJSONSchema` (see `zodToJsonSchema`). The index signature
 * keeps it permissive enough for any JSON-Schema keyword while naming the
 * fields this adapter actually emits.
 */
export type PiToolParameters = {
  type?: string;
  properties?: Record<string, PiToolParameters>;
  required?: string[];
  items?: PiToolParameters;
  enum?: unknown[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

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
   * Translated from the disclaude Zod schema so the model sees the real
   * parameter shape. Falls back to a permissive placeholder if Zod cannot
   * serialize the schema (execute still validates inputs at runtime).
   */
  parameters: PiToolParameters;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: PiAgentToolUpdateCallback | undefined,
    context: unknown
  ) => Promise<PiAgentToolResult>;
}

/**
 * Render a handler result as the model-facing content array: strings pass
 * through verbatim, everything else is JSON-stringified. `JSON.stringify`
 * returns `undefined` only for `undefined` input, which we normalize to
 * `'null'` so `text` is always a string (as `TextContent` requires).
 */
function toContent(result: unknown): (PiTextContent | PiImageContent)[] {
  const text = typeof result === 'string' ? result : (JSON.stringify(result) ?? 'null');
  return [{ type: 'text', text }];
}

/**
 * Translate a disclaude Zod parameter schema into the JSON-Schema shape pi's
 * TypeBox `TSchema` serializes to — i.e. what the model reads as the tool's
 * input schema (TypeBox's runtime representation IS JSON Schema). Uses Zod's
 * own `z.toJSONSchema` so we follow Zod's semantics exactly
 * (string/number/boolean/array/object/enum/required, strict objects) rather
 * than hand-rolling a walker that would be fragile across Zod versions.
 *
 * On any translation failure (exotic or custom Zod types Zod itself cannot
 * serialize) the permissive placeholder is returned so the tool still registers
 * — execute continues to validate inputs authoritatively via Zod at runtime.
 */
function zodToJsonSchema(parameters: z.ZodType): PiToolParameters {
  try {
    const schema = z.toJSONSchema(parameters) as Record<string, unknown>;
    // `z.toJSONSchema` annotates the document root with `$schema`; a tool input
    // schema is a nested schema (TypeBox's nested object schemas don't carry
    // it), so strip it to keep the model-facing schema clean.
    if (schema && typeof schema === 'object' && '$schema' in schema) {
      delete schema.$schema;
    }
    return schema as PiToolParameters;
  } catch {
    return { type: 'object', additionalProperties: true };
  }
}

/**
 * Adapt a disclaude `InlineToolDefinition` into a pi `AgentHarnessTool` shape.
 *
 * The execute wrapper:
 * 1. Honors an already-aborted signal (throws).
 * 2. Asks the permission gate (#4389) — a deny throws with the gate's reason
 *    BEFORE the handler runs (the deny path is the threat-model invariant:
 *    a disallowed tool call does not execute).
 * 3. Validates `params` through the disclaude Zod schema (authoritative).
 * 4. Invokes the disclaude handler with the parsed params.
 * 5. Shapes the success value as a pi `AgentToolResult` (`content` +
 *    `details`).
 *
 * Per pi's `AgentTool.execute` contract, failures (abort, permission denies,
 * param-validation errors, handler errors) are THROWN rather than encoded in
 * `content`: pi's agent loop catches a thrown execute error and synthesizes an
 * `isError` tool result from the message (see `executePreparedToolCall` in
 * pi-agent-core). Keeping the success return always in the `{ content, details }`
 * shape is what lets the model consume tool output correctly.
 *
 * @param definition - the disclaude tool to wrap.
 * @param gate - disclaude-owned permission gate consulted before every
 *   execution (#4389). Defaults to allow-all (pre-#4389 behavior) so callers
 *   that have not installed a policy are unaffected.
 */
export function adaptInlineTool(
  definition: InlineToolDefinition,
  gate: PiPermissionGate = ALLOW_ALL_GATE,
): PiAgentHarnessTool {
  return {
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: zodToJsonSchema(definition.parameters),

    execute: async (_toolCallId, params, signal, _onUpdate, _context) => {
      if (signal?.aborted) {
        throw new Error('aborted before execution');
      }
      // #4389: disclaude is the sole permission authority on the pi path —
      // consult the gate before anything else touches the handler. The deny
      // reason becomes the isError text the model sees.
      const decision = gate.decide({ toolName: definition.name, args: params });
      if (!decision.allowed) {
        throw new Error(`permission denied: ${decision.reason}`);
      }
      // Authoritative param validation via the disclaude Zod schema.
      // Throws on invalid input — pi converts to an isError tool result.
      const parsed = definition.parameters.parse(params);
      const result = await definition.handler(parsed);
      return { content: toContent(result), details: result };
    },
  };
}
