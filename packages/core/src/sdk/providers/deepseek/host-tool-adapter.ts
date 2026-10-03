import { prepareHostTools, type HostToolDefinition } from '../../host-tools.js';
import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  type ToolRuntime,
} from '@deepseek-ai/dsh-tools';

/** The public dsh-tools registration boundary; no Codex or inline-MCP shape. */
export type DshHostToolRegistry = Pick<ToolRuntime, 'register'>;

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

/** Register canonical tools directly in the agent-scoped DSH native registry. */
export function registerDshHostTools(
  registry: DshHostToolRegistry,
  tools: readonly HostToolDefinition[]
): () => void {
  const prepared = prepareHostTools(tools).map((tool) => {
    const parameters = nativeDeclaration(tool.inputSchema);
    const outputSchema = nativeDeclaration(tool.outputSchema);
    assertObjectJsonSchema(parameters);
    assertSupportedJsonSchema(outputSchema);
    return { tool, parameters, outputSchema };
  });
  const disposers: (() => void)[] = [];
  try {
    for (const { tool, parameters, outputSchema } of prepared) {
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
            // Native DSH policy, call identity and cancellation remain native.
            // Validate the original schema before/after the business callback.
            const value = await tool.execute(args as Record<string, unknown>, {
              signal: context.signal,
              ...(context.callId === undefined ? {} : { invocationId: String(context.callId) }),
            });
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
