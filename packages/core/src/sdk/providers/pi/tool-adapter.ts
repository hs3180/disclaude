import { prepareTools, type ToolDefinition } from '../../tools.js';

export interface PiAgentToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown;
}

export interface PiAgentHarnessTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((result: PiAgentToolResult) => void) | undefined,
    context: unknown
  ): Promise<PiAgentToolResult>;
}

function result(value: unknown): PiAgentToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    details: value,
  };
}

/** Pi uses its native registry; the business definition stays in tools. */
export function adaptPiTools(definitions: readonly ToolDefinition[] = []): PiAgentHarnessTool[] {
  return prepareTools(definitions).map((definition) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const value = await definition.execute(params as Record<string, unknown>, {
        signal: signal ?? new AbortController().signal,
        ...(onUpdate
          ? {
              onProgress: (progress: unknown) => {
                try {
                  onUpdate(result(progress));
                } catch {
                  /* Progress is best-effort. */
                }
              },
            }
          : {}),
      });
      return result(value);
    },
  }));
}
