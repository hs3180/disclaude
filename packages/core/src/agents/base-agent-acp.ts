/**
 * ACP-specific utilities for BaseAgent.
 *
 * Contains pure functions for ACP session options conversion,
 * message format conversion, and SDK options building.
 *
 * Extracted from base-agent.ts as part of Issue #2345 Phase 2.
 *
 * @module agents/base-agent-acp
 */

import type { AgentQueryOptions, AgentMessage as SdkAgentMessage } from '../sdk/index.js';
import { buildSdkEnv } from '../utils/sdk.js';
import { loadRuntimeEnv } from '../config/runtime-env.js';

/**
 * Extra SDK options configuration.
 *
 * Kept for backward compatibility with subclasses (ChatAgent, etc.).
 * Internally translated to ACP session parameters.
 */
export interface SdkOptionsExtra {
  /** Allowed tools list */
  allowedTools?: string[];
  /** Disallowed tools list */
  disallowedTools?: string[];
  /** MCP servers configuration */
  mcpServers?: Record<string, unknown>;
  /** Custom working directory */
  cwd?: string;
}

/**
 * Context interface for buildSdkOptions.
 * Provides the agent-specific values needed to construct SDK options.
 */
export interface SdkBuildContext {
  workspaceDir: string;
  permissionMode: 'default' | 'bypassPermissions';
  loggingConfig: { sdkDebug: boolean };
  globalEnv: Record<string, string>;
  agentTeamsEnabled: boolean;
  apiKey: string;
  apiBaseUrl?: string;
  model: string;
}

/**
 * Convert AgentQueryOptions to ACP session creation parameters.
 *
 * Maps all SDK options to the corresponding ACP session/new parameters
 * passed via _meta.claudeCode.options.
 */
export function toAcpSessionOptions(
  options: AgentQueryOptions,
): {
  permissionMode?: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  env?: Record<string, string>;
  settingSources?: string[];
} {
  const result: ReturnType<typeof toAcpSessionOptions> = {};

  // Issue #2463: MCP servers are NO longer passed via session/new.
  // ACP v0.23.1+ only supports http/sse MCP transports in session/new.
  // Stdio MCP servers are now written to {workspace}/.mcp.json by ChatAgent
  // so that Claude Code loads them natively from the working directory.
  // The mcpServers field is intentionally omitted from session options.

  // Pass permission mode
  if (options.permissionMode) {
    result.permissionMode = options.permissionMode;
  }

  // Pass model selection
  if (options.model) {
    result.model = options.model;
  }

  // Pass tool restrictions
  if (options.allowedTools) {
    result.allowedTools = options.allowedTools;
  }
  if (options.disallowedTools) {
    result.disallowedTools = options.disallowedTools;
  }

  // Pass environment variables (filter out undefined values)
  if (options.env) {
    const filteredEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env)) {
      if (v !== undefined) {
        filteredEnv[k] = v;
      }
    }
    if (Object.keys(filteredEnv).length > 0) {
      result.env = filteredEnv;
    }
  }

  // Pass setting sources
  if (options.settingSources) {
    result.settingSources = options.settingSources;
  }

  return result;
}

/**
 * Convert ACP AgentMessage to legacy parsed format for compatibility.
 *
 * ACP messages (from message-adapter.ts) are already AgentMessage format,
 * but we convert to the legacy parsed structure for backward compatibility
 * with subclasses.
 */
export function convertToLegacyFormat(message: SdkAgentMessage): {
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
} {
  return {
    type: message.type,
    content: message.content,
    metadata: message.metadata ? {
      toolName: message.metadata.toolName,
      toolInput: message.metadata.toolInput,
      toolInputRaw: message.metadata.toolInput,
      toolOutput: message.metadata.toolOutput,
      elapsed: message.metadata.elapsedMs,
      cost: message.metadata.costUsd,
      tokens: (message.metadata.inputTokens ?? 0) + (message.metadata.outputTokens ?? 0),
    } : undefined,
    sessionId: message.metadata?.sessionId,
  };
}

/**
 * Build SDK options for agent execution.
 *
 * Constructs AgentQueryOptions from agent context and extra configuration.
 * Extracted from BaseAgent.createSdkOptions() for Issue #2345 Phase 2.
 */
export function buildSdkOptions(
  ctx: SdkBuildContext,
  extra: SdkOptionsExtra = {},
): AgentQueryOptions {
  const options: AgentQueryOptions = {
    cwd: extra.cwd ?? ctx.workspaceDir,
    permissionMode: ctx.permissionMode,
    settingSources: ['project'],
  };

  // Add allowed/disallowed tools
  if (extra.allowedTools) {
    options.allowedTools = extra.allowedTools;
  }
  if (extra.disallowedTools) {
    options.disallowedTools = extra.disallowedTools;
  }

  // Add MCP servers (convert to SDK format)
  if (extra.mcpServers) {
    options.mcpServers = extra.mcpServers as Record<string, import('../sdk/index.js').SdkMcpServerConfig>;
  }

  // Set environment: config env + runtime env file (Issue #1361)
  const globalEnv: Record<string, string> = {};
  Object.entries({ ...ctx.globalEnv, ...loadRuntimeEnv(ctx.workspaceDir) }).forEach(
    ([k, v]) => { if (v !== undefined) { globalEnv[k] = v; } }
  );
  if (ctx.agentTeamsEnabled) {
    globalEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  }
  options.env = buildSdkEnv(
    ctx.apiKey,
    ctx.apiBaseUrl,
    globalEnv,
    ctx.loggingConfig.sdkDebug,
  );

  // Set model
  if (ctx.model) {
    options.model = ctx.model;
  }

  return options;
}
