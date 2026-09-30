import { z } from 'zod';
import type { InlineToolDefinition, McpServerConfig } from '../../types.js';
import type {
  CodexAppServerDynamicToolCallRequest,
  CodexAppServerDynamicToolCallResult,
  CodexAppServerDynamicToolSpec,
} from './app-server-transport.js';

interface InlineServerHandle {
  name?: string;
  type?: string;
  tools?: unknown;
}

interface RegisteredTool {
  definition: InlineToolDefinition;
  namespace: string;
}

export interface CodexDynamicToolRegistry {
  specs: CodexAppServerDynamicToolSpec[];
  call(request: CodexAppServerDynamicToolCallRequest): Promise<CodexAppServerDynamicToolCallResult>;
}

/** Convert inline disclaude MCP tools to Codex app-server's experimental host-tool protocol. */
export function createCodexDynamicToolRegistry(
  servers: Record<string, McpServerConfig> | undefined
): CodexDynamicToolRegistry {
  const registered = new Map<string, RegisteredTool>();
  const namespaces = new Map<string, InlineToolDefinition[]>();

  for (const [key, rawServer] of Object.entries(servers ?? {})) {
    if (!rawServer || typeof rawServer !== 'object') {
      throw new Error(
        `Codex app-server cannot adapt MCP server "${key}": invalid server definition`
      );
    }
    const server = rawServer as InlineServerHandle;
    if (server.type === 'stdio') {
      throw new Error(`Codex app-server host tools do not support stdio MCP server "${key}"`);
    }
    if (server.type !== undefined && server.type !== 'inline') {
      throw new Error(`Codex app-server cannot adapt MCP server "${key}": unsupported type`);
    }
    if (server.tools !== undefined && !Array.isArray(server.tools)) {
      throw new Error(`Codex app-server cannot adapt MCP server "${key}": expected inline tools`);
    }

    const namespace =
      typeof server.name === 'string' && server.name.trim() ? server.name.trim() : key;
    if (namespace.length === 0) {
      throw new Error(`Codex app-server cannot adapt MCP server "${key}": namespace is empty`);
    }
    if (namespaces.has(namespace)) {
      throw new Error(`Codex app-server dynamic tool namespace "${namespace}" is duplicated`);
    }
    const tools: InlineToolDefinition[] = [];
    for (const candidate of server.tools ?? []) {
      if (!isInlineToolDefinition(candidate)) {
        throw new Error(
          `Codex app-server cannot adapt MCP server "${namespace}": invalid inline tool definition`
        );
      }
      const identity = toolIdentity(namespace, candidate.name);
      if (registered.has(identity)) {
        throw new Error(
          `Codex app-server dynamic tool "${namespace}/${candidate.name}" is duplicated`
        );
      }
      registered.set(identity, { namespace, definition: candidate });
      tools.push(candidate);
    }
    namespaces.set(namespace, tools);
  }

  const specs = [...namespaces]
    .sort(([left], [right]) => compare(left, right))
    .map(([name, tools]) => ({
      type: 'namespace' as const,
      name,
      description: `Inline tools exposed by ${name}`,
      tools: [...tools]
        .sort((left, right) => compare(left.name, right.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: toJsonSchema(name, tool),
        })),
    }));

  return {
    specs,
    call: async (request) => {
      const registeredTool = findTool(registered, request.namespace, request.tool);
      if (!registeredTool) {
        return failure('Requested host tool is not registered');
      }
      if (request.signal.aborted) {
        return failure('Host tool call was cancelled before execution');
      }
      try {
        const parsed = registeredTool.definition.parameters.parse(request.arguments);
        const result = await registeredTool.definition.handler(parsed, undefined, {
          signal: request.signal,
        });
        if (request.signal.aborted) {
          return failure('Host tool call was cancelled');
        }
        return {
          contentItems: [{ type: 'inputText', text: stringifyToolResult(result) }],
          success: true,
        };
      } catch (error) {
        return failure(error instanceof Error ? error.message : 'Host tool execution failed');
      }
    },
  };
}

function isInlineToolDefinition(value: unknown): value is InlineToolDefinition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<InlineToolDefinition>;
  return (
    typeof candidate.name === 'string' &&
    candidate.name.trim().length > 0 &&
    candidate.name.trim() === candidate.name &&
    typeof candidate.description === 'string' &&
    typeof candidate.parameters === 'object' &&
    candidate.parameters !== null &&
    'parse' in candidate.parameters &&
    typeof candidate.parameters.parse === 'function' &&
    typeof candidate.handler === 'function'
  );
}

function toJsonSchema(namespace: string, tool: InlineToolDefinition): Record<string, unknown> {
  try {
    const schema = z.toJSONSchema(tool.parameters) as Record<string, unknown>;
    if ('$schema' in schema) {
      delete schema.$schema;
    }
    return schema;
  } catch {
    throw new Error(
      `Codex app-server cannot expose "${namespace}/${tool.name}": its Zod schema is not JSON serializable`
    );
  }
}

function findTool(
  tools: Map<string, RegisteredTool>,
  namespace: string | null | undefined,
  name: string
): RegisteredTool | undefined {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    return undefined;
  }
  return tools.get(toolIdentity(namespace, name));
}

function toolIdentity(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result) ?? 'null';
  } catch {
    throw new Error('Host tool returned a non-serializable result');
  }
}

function failure(message: string): CodexAppServerDynamicToolCallResult {
  return { contentItems: [{ type: 'inputText', text: message }], success: false };
}
