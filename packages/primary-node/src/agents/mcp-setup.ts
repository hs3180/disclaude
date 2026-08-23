/**
 * MCP Server setup utility for ChatAgent.
 *
 * Extracted from chat-agent.ts (Issue #4125 part 1).
 *
 * @module agents/mcp-setup
 */

import { Config } from '@disclaude/core';
import { createChannelMcpServer } from '@disclaude/mcp-server';
import type { Logger } from 'pino';

/**
 * Capabilities provider interface for MCP server configuration.
 */
export interface McpCapabilitiesProvider {
  getCapabilities?: (chatId: string) => { supportedMcpTools?: string[] } | undefined;
}

/**
 * Process-level flag: has the external-MCP deprecation warning fired yet?
 *
 * `buildMcpServers()` runs on every agent-loop start (restarts included), but
 * the warning is migration guidance for the operator, not per-loop diagnostics
 * — one warning per process is enough to be non-silent without log spam.
 */
let externalMcpDeprecationWarned = false;

/**
 * Build MCP servers configuration for agent SDK.
 *
 * Combines:
 * - Channel MCP server (inline transport, for send_text/send_card/etc.)
 * - Externally configured MCP servers from config file (stdio transport)
 *
 * @param chatId - The bound chat ID for capability lookup
 * @param callbacks - Callbacks providing capability info
 * @param skipChannelMcp - If true, skips the channel MCP server (for one-shot/CLI mode)
 * @param logger - Logger instance (typically the caller agent's logger for consistent log source)
 * @returns MCP servers configuration object
 */
export function buildMcpServers(
  chatId: string,
  callbacks: McpCapabilitiesProvider,
  skipChannelMcp: boolean,
  logger: Logger,
): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};

  if (!skipChannelMcp) {
    // Get channel capabilities for MCP server filtering (Issue #590 Phase 3)
    const capabilities = callbacks.getCapabilities?.(chatId);
    const supportedMcpTools = capabilities?.supportedMcpTools;

    // Determine if we should include Context MCP server
    const contextTools = ['send_text', 'send_card', 'send_interactive', 'send_file'];
    const shouldIncludeContextMcp = supportedMcpTools === undefined ||
      contextTools.some(tool => supportedMcpTools.includes(tool));

    // Use inline transport for channel MCP server
    if (shouldIncludeContextMcp) {
      mcpServers['channel-mcp'] = createChannelMcpServer();

      logger.info({
        ipcSocket: process.env.DISCLAUDE_WORKER_IPC_SOCKET,
      }, 'Configured channel MCP server (inline transport)');
    }
  }

  // Merge configured external MCP servers from config file.
  // Deprecated (#4459 scope 4): external stdio MCP servers are slated for removal in favor of
  // Skills (CLI + README). Configured servers keep working until the loader is removed, but every
  // process logs the migration warning once — the migration is never silent.
  const configuredMcpServers = Config.getMcpServersConfig();
  if (configuredMcpServers && Object.keys(configuredMcpServers).length > 0) {
    if (!externalMcpDeprecationWarned) {
      externalMcpDeprecationWarned = true;
      logger.warn(
        { servers: Object.keys(configuredMcpServers) },
        'External MCP servers are deprecated (#4459) — migrate each server to a Skill ' +
        '(CLI + README, see docs/skill-format-spec.md); the stdio loader will be removed',
      );
    }
    for (const [name, config] of Object.entries(configuredMcpServers)) {
      mcpServers[name] = {
        type: 'stdio',
        command: config.command,
        args: config.args || [],
        ...(config.env && { env: config.env }),
      };
    }
  }

  return mcpServers;
}

/**
 * Reset the process-level external-MCP deprecation warning flag.
 *
 * 用于测试或需要重新触发弃用告警时。
 */
export function resetExternalMcpDeprecationWarning(): void {
  externalMcpDeprecationWarned = false;
}

/**
 * Issue #4302: extract the closeable in-process McpServer instances from a
 * {@link buildMcpServers} result.
 *
 * Inline (in-process) servers — e.g. the channel-mcp server, built via the
 * SDK's `createSdkMcpServer`, which returns a `{ type: 'sdk', name, instance }`
 * wrapper — carry an `.instance` (an MCP SDK `McpServer` exposing `close()`)
 * that disclaude created and can tear down explicitly. Detection is duck-typed
 * on `.instance.close` (the `type` field is intentionally ignored, so it tracks
 * the real production shape). Stdio external-server configs do NOT
 * have an `.instance` — their subprocesses are spawned by the SDK inside the
 * CLI child and have no disclaude-side handle, so they are skipped here (their
 * teardown remains SDK-dependent; see #4302 criterion 1).
 *
 * The caller (ChatAgent) retains these and `close()`s them on `dispose()` as
 * defense-in-depth, rather than relying solely on the SDK's
 * `queryHandle.close()` cascade (which is verified for the query transport but
 * not for these in-process instances).
 *
 * @param mcpServers - The record returned by {@link buildMcpServers}.
 * @returns Closeable inline McpServer instances (empty if there are none).
 */
export function collectInlineMcpInstances(
  mcpServers: Record<string, unknown>,
): Array<{ close(): Promise<void> | void }> {
  const instances: Array<{ close(): Promise<void> | void }> = [];
  for (const cfg of Object.values(mcpServers)) {
    const inst = (cfg as { instance?: { close(): Promise<void> | void } } | null | undefined)?.instance;
    if (inst && typeof inst.close === 'function') {
      instances.push(inst);
    }
  }
  return instances;
}

