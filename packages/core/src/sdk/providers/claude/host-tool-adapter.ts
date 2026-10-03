import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { prepareHostTools, selectHostTools, type HostToolDefinition } from '../../host-tools.js';

export const CLAUDE_HOST_SERVER = 'disclaude';

/** Claude requires an in-process MCP server; that transport stays inside its adapter. */
export function createClaudeHostToolServer(
  definitions: readonly HostToolDefinition[],
  permissions: { allowedTools?: string[]; disallowedTools?: string[] } = {}
) {
  const tools = selectHostTools(prepareHostTools(definitions), permissions);
  const registered = new Map(tools.map((tool) => [tool.name, tool]));
  const handle = createSdkMcpServer({ name: CLAUDE_HOST_SERVER, version: '1.0.0', tools: [] });
  // Raw MCP request handlers preserve the canonical schemas without a lossy Zod conversion.
  handle.instance.server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: tools.map(({ name, description, inputSchema, outputSchema }) => ({
        name,
        description,
        inputSchema,
        ...(outputSchema.type === 'object' ? { outputSchema } : {}),
      })),
    })
  );
  handle.instance.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, { signal, requestId }) => {
      const tool = registered.get(request.params.name);
      if (!tool) {
        return {
          content: [{ type: 'text', text: 'Requested host tool is not registered' }],
          isError: true,
        };
      }
      try {
        const value = await tool.execute(request.params.arguments ?? {}, {
          signal,
          invocationId: String(requestId),
        });
        return {
          content: [
            { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
          ],
          ...(value !== null && typeof value === 'object' && !Array.isArray(value)
            ? { structuredContent: value }
            : {}),
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : 'Host tool execution failed',
            },
          ],
          isError: true,
        };
      }
    }
  );
  return handle;
}

/** Translate a canonical host name only at Claude's SDK permission boundary. */
export function claudeToolNames(
  names: string[] | undefined,
  definitions: readonly HostToolDefinition[] = []
): string[] | undefined {
  const host = new Set(definitions.map((tool) => tool.name));
  return names?.map((name) => (host.has(name) ? `mcp__${CLAUDE_HOST_SERVER}__${name}` : name));
}
