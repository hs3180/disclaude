import { getProvider } from '@disclaude/core';
import { ChatAgent } from './chat-agent.js';
import type { ChatAgentConfig } from './types.js';

/** Let the selected provider compose chat hooks through the common interface. */
export function createChatAgent(config: ChatAgentConfig): ChatAgent {
  const provider = getProvider(config.agentBackend);
  const hooks = {
    messageBuilderOptions: config.messageBuilderOptions,
    configureQueryOptions: config.configureQueryOptions,
  };
  const configured = provider.configureChat?.(hooks) ?? hooks;
  return new ChatAgent({
    ...config,
    messageBuilderOptions: configured.messageBuilderOptions,
    configureQueryOptions: configured.configureQueryOptions,
  });
}
