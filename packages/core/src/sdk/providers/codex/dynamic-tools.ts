import { prepareTools, type ToolDefinition } from '../../tools.js';
import type {
  CodexAppServerDynamicToolCallRequest,
  CodexAppServerDynamicToolCallResult,
  CodexAppServerDynamicToolSpec,
} from './app-server-transport.js';

export interface CodexDynamicToolRegistry {
  specs: CodexAppServerDynamicToolSpec[];
  /** Includes output contracts even when the native protocol only declares inputs. */
  signature: string;
  call(request: CodexAppServerDynamicToolCallRequest): Promise<CodexAppServerDynamicToolCallResult>;
}

/** The namespace is a Codex transport detail, shared by all host-owned tools. */
const HOST_NAMESPACE = 'disclaude';

export function createCodexDynamicToolRegistry(
  definitions: readonly ToolDefinition[] = []
): CodexDynamicToolRegistry {
  const tools = prepareTools(definitions).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  const registered = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    signature: JSON.stringify(
      tools.map(({ name, description, inputSchema, outputSchema }) => ({
        name,
        description,
        inputSchema,
        outputSchema,
      }))
    ),
    specs: tools.length
      ? [
          {
            type: 'namespace',
            name: HOST_NAMESPACE,
            description: 'Host-owned disclaude tools',
            tools: tools.map(({ name, description, inputSchema }) => ({
              type: 'function',
              name,
              description,
              inputSchema,
            })),
          },
        ]
      : [],
    call: async (request) => {
      const tool = request.namespace === HOST_NAMESPACE ? registered.get(request.tool) : undefined;
      if (!tool) {
        return failure('Requested host tool is not registered');
      }
      try {
        const value = await tool.execute(request.arguments as Record<string, unknown>, {
          signal: request.signal,
        });
        return {
          contentItems: [
            { type: 'inputText', text: typeof value === 'string' ? value : JSON.stringify(value) },
          ],
          success: true,
        };
      } catch (error) {
        return failure(error instanceof Error ? error.message : 'Host tool execution failed');
      }
    },
  };
}

function failure(message: string): CodexAppServerDynamicToolCallResult {
  return { contentItems: [{ type: 'inputText', text: message }], success: false };
}
