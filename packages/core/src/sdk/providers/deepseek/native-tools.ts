import type { NativeAgentTool } from '../../native-tools.js';
import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  type ToolRuntime,
} from '@deepseek-ai/dsh-tools';

/** The public dsh-tools registration boundary; no Codex or inline-MCP shape. */
export type DshNativeToolRegistry = Pick<ToolRuntime, 'register'>;

/** Register canonical tools directly in the agent-scoped DSH native registry. */
export function registerDshNativeTools(
  registry: DshNativeToolRegistry,
  tools: readonly NativeAgentTool[]
): () => void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || names.has(tool.name)) {
      throw new Error(`Invalid or duplicate native tool name: ${tool.name}`);
    }
    names.add(tool.name);
    assertObjectJsonSchema(tool.inputSchema);
    assertSupportedJsonSchema(tool.outputSchema);
  }
  const disposers: (() => void)[] = [];
  try {
    for (const tool of tools) {
      const parameters = tool.inputSchema;
      const { outputSchema } = tool;
      assertObjectJsonSchema(parameters);
      assertSupportedJsonSchema(outputSchema);
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
            // DSH owns input/output schema checks, policy, call identity and
            // cancellation. Await the business operation to quiescence.
            return await tool.execute(args as Record<string, unknown>, {
              signal: context.signal,
              ...(context.callId === undefined ? {} : { invocationId: String(context.callId) }),
            });
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
