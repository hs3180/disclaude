import type { NativeAgentTool } from '../../native-tools.js';
import Ajv, { type ValidateFunction } from 'ajv';
import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  type ToolRuntime,
} from '@deepseek-ai/dsh-tools';

/** The public dsh-tools registration boundary; no Codex or inline-MCP shape. */
export type DshNativeToolRegistry = Pick<ToolRuntime, 'register'>;

/** DSH 0.1.2 has a narrower declaration DSL. Keep constraints enforced. */
function nativeDeclaration(schema: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const result: Record<string, unknown> = {};
  const lengths: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'minLength' || key === 'maxLength') {
      changed = true;
      lengths.push(`${key}=${String(value)}`);
    } else if (key === 'properties') {
      const properties: Record<string, unknown> = {};
      for (const [name, definition] of Object.entries(
        value as Record<string, Record<string, unknown>>
      )) {
        properties[name] = nativeDeclaration(definition);
        changed ||= properties[name] !== definition;
      }
      result[key] = properties;
    } else if (key === 'items') {
      result[key] = nativeDeclaration(value as Record<string, unknown>);
      changed ||= result[key] !== value;
    } else if (key === 'oneOf') {
      result[key] = (value as Record<string, unknown>[]).map((branch) => {
        const declaration = nativeDeclaration(branch);
        changed ||= declaration !== branch;
        return declaration;
      });
    } else {
      result[key] = value;
    }
  }
  if (lengths.length) {
    result.description = [
      schema.description,
      `Host-enforced string constraints: ${lengths.join(', ')}.`,
    ]
      .filter(Boolean)
      .join(' ');
  }
  return changed ? result : schema;
}

function validateValue(validate: ValidateFunction, value: unknown, kind: string, ajv: Ajv): void {
  if (!validate(value)) {
    // Default non-verbose errors contain schema paths/constraints, not values.
    throw new TypeError(`Invalid native tool ${kind}: ${ajv.errorsText(validate.errors)}`);
  }
}

/** Register canonical tools directly in the agent-scoped DSH native registry. */
export function registerDshNativeTools(
  registry: DshNativeToolRegistry,
  tools: readonly NativeAgentTool[]
): () => void {
  const names = new Set<string>();
  const ajv = new Ajv({
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  const prepared = tools.map((tool) => {
    const input = ajv.compile(tool.inputSchema);
    const output = ajv.compile(tool.outputSchema);
    const parameters = nativeDeclaration(tool.inputSchema);
    const outputSchema = nativeDeclaration(tool.outputSchema);
    assertObjectJsonSchema(parameters);
    assertSupportedJsonSchema(outputSchema);
    return { tool, input, output, parameters, outputSchema };
  });
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || names.has(tool.name)) {
      throw new Error(`Invalid or duplicate native tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
  const disposers: (() => void)[] = [];
  try {
    for (const { tool, input, output, parameters, outputSchema } of prepared) {
      disposers.push(
        registry.register({
          name: tool.name,
          description: tool.description,
          parameters,
          output: {
            schema: outputSchema,
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
            presentationMeta: (_args, value) => value,
          },
          execute: async (args, context) => {
            context.signal.throwIfAborted();
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
              throw new TypeError('Native tool arguments must be an object');
            }
            validateValue(input, args, 'arguments', ajv);
            // Native DSH policy, call identity and cancellation remain native.
            // Validate the original schema before/after the business callback.
            const value = await tool.execute(args as Record<string, unknown>, {
              signal: context.signal,
              ...(context.callId === undefined ? {} : { invocationId: String(context.callId) }),
            });
            validateValue(output, value, 'result', ajv);
            return value;
          },
        })
      );
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      dispose();
    }
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const dispose of disposers.reverse()) {
      dispose();
    }
  };
}
