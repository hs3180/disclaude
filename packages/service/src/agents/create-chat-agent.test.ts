import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getProvider, type AgentQueryOptions, type ChatAgentHooks, type IAgentSDKProvider } from '@disclaude/core';
import { ChatAgent } from './chat-agent.js';
import type { ChatAgentConfig } from './types.js';
import { createChatAgent } from './create-chat-agent.js';

vi.mock('@disclaude/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@disclaude/core')>()),
  getProvider: vi.fn(),
}));
vi.mock('./chat-agent.js', () => ({
  ChatAgent: vi.fn(class {}),
}));

const baseConfig = (): ChatAgentConfig => ({
  chatId: 'chat',
  apiKey: 'test',
  model: 'test',
  callbacks: { sendMessage: vi.fn(), sendCard: vi.fn(), sendFile: vi.fn() },
});
const lastConfig = (): ChatAgentConfig => vi.mocked(ChatAgent).mock.calls.at(-1)![0];

describe('createChatAgent', () => {
  beforeEach(() => vi.resetAllMocks());

  it('uses the common provider hook and preserves the service configuration', () => {
    const callerHooks = Object.freeze<ChatAgentHooks>({
      messageBuilderOptions: { buildHeader: () => 'Channel header' },
      configureQueryOptions: (options) => ({ ...options, model: 'caller-model' }),
    });
    const configuredHooks: ChatAgentHooks = {
      messageBuilderOptions: { buildHeader: () => 'Composed header' },
      configureQueryOptions: (options) => ({ ...options, model: 'provider-model' }),
    };
    // The creation function needs only the common capability, not a backend name.
    const configureChat = vi.fn(() => configuredHooks);
    vi.mocked(getProvider).mockReturnValue({ configureChat } as unknown as IAgentSDKProvider);
    const config = Object.freeze({
      ...baseConfig(),
      ...callerHooks,
      agentBackend: 'pi' as const,
      cwdResolver: () => ({
        reason: 'unbound' as const,
        effectiveCwd: undefined,
        boundWorkingDir: undefined,
      }),
      sdkSessionKey: 'project-session',
    });

    const agent = createChatAgent(config);

    expect(getProvider).toHaveBeenCalledExactlyOnceWith('pi');
    expect(configureChat).toHaveBeenCalledExactlyOnceWith(callerHooks);
    expect(agent).toBeInstanceOf(ChatAgent);
    expect(lastConfig()).toEqual({ ...config, ...configuredHooks });
    expect(lastConfig().callbacks).toBe(config.callbacks);
    expect(lastConfig().cwdResolver).toBe(config.cwdResolver);
    expect(config.configureQueryOptions).toBe(callerHooks.configureQueryOptions);
  });

  it.each([undefined, 'pi'] as const)(
    'preserves caller hooks for a provider without chat configuration (override: %s)',
    (agentBackend) => {
      vi.mocked(getProvider).mockReturnValue({} as IAgentSDKProvider);
      const config = Object.freeze({
        ...baseConfig(),
        agentBackend,
        messageBuilderOptions: Object.freeze({ buildHeader: () => 'Channel header' }),
        configureQueryOptions: (options: AgentQueryOptions) => options,
      });

      createChatAgent(config);

      expect(getProvider).toHaveBeenCalledExactlyOnceWith(agentBackend);
      expect(lastConfig()).toEqual(config);
      expect(lastConfig().messageBuilderOptions).toBe(config.messageBuilderOptions);
      expect(lastConfig().configureQueryOptions).toBe(config.configureQueryOptions);
    }
  );

  it('keeps hooks optional when neither the caller nor the provider supplies them', () => {
    vi.mocked(getProvider).mockReturnValue({} as IAgentSDKProvider);

    createChatAgent(baseConfig());

    expect(getProvider).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(lastConfig().messageBuilderOptions).toBeUndefined();
    expect(lastConfig().configureQueryOptions).toBeUndefined();
  });
});
