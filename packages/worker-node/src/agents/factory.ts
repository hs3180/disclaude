/**
 * AgentFactory re-export with worker-node specific defaults.
 *
 * Issue #2717 Phase 1: Implementation migrated to @disclaude/core.
 * This file re-exports from core and auto-injects createChannelMcpServer
 * for backward compatibility with existing worker-node consumers.
 */

import {
  AgentFactory as CoreAgentFactory,
  type AgentCreateOptions,
  type ChatAgentCallbacks,
  type ChatAgent as ChatAgentInterface,
} from '@disclaude/core';
export { toChatAgentCallbacks, type AgentCreateOptions } from '@disclaude/core';
import { createChannelMcpServer } from '@disclaude/mcp-server';

/**
 * AgentFactory - Factory for creating ChatAgent instances.
 *
 * Wraps the core AgentFactory to automatically inject createChannelMcpServer.
 * Issue #2717 Phase 1: Implementation is in @disclaude/core, this wrapper
 * provides backward compatibility by auto-injecting the MCP server factory.
 */
export const AgentFactory = {
  createAgent(
    chatId: string,
    callbacks: ChatAgentCallbacks,
    options: AgentCreateOptions = {},
  ): ChatAgentInterface {
    return CoreAgentFactory.createAgent(chatId, callbacks, {
      ...options,
      createChannelMcpServer: options.createChannelMcpServer ?? createChannelMcpServer,
    });
  },
};
