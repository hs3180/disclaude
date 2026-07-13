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

  // Merge configured external MCP servers from config file
  const configuredMcpServers = Config.getMcpServersConfig();
  if (configuredMcpServers) {
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
 * Issue #4302: extract the closeable in-process McpServer instances from a
 * {@link buildMcpServers} result.
 *
 * Inline servers (`McpSdkServerConfigWithInstance`, e.g. channel-mcp) carry an
 * `.instance` (an MCP SDK `McpServer` with a `close()` method) that disclaude
 * created and can tear down explicitly. Stdio external-server configs do NOT
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

