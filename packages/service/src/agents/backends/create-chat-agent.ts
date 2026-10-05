import { getProvider } from '@disclaude/core';
import { ChatAgent } from '../chat-agent.js';
import type { ChatAgentConfig } from '../types.js';
import { buildClaudeDisallowedTools } from './claude-disallowed-tools.js';
import { withCodexSourceCitations } from './codex-source-citations.js';

/** Resolve backend policies at the creation boundary, then inject callbacks. */
export function createChatAgent(config: ChatAgentConfig): ChatAgent {
  const backend = getProvider(config.agentBackend).name;
  return new ChatAgent({
    ...config,
    messageBuilderOptions:
      backend === 'codex'
        ? withCodexSourceCitations(config.messageBuilderOptions)
        : config.messageBuilderOptions,
    configureQueryOptions:
      backend === 'claude'
        ? (options) => ({
            ...(config.configureQueryOptions?.(options) ?? options),
            disallowedTools: buildClaudeDisallowedTools(),
          })
        : config.configureQueryOptions,
  });
}
