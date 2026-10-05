import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBuilder, getProvider, type AgentQueryOptions } from '@disclaude/core';
import { ChatAgent } from '../chat-agent.js';
import type { ChatAgentConfig } from '../types.js';
import { createChatAgent } from './create-chat-agent.js';

const runtime = vi.hoisted(() => ({ defaultBackend: 'claude' }));
vi.mock('@disclaude/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@disclaude/core')>()),
  getProvider: vi.fn((backend?: string) => ({ name: backend ?? runtime.defaultBackend })),
}));
vi.mock('../chat-agent.js', () => ({
  ChatAgent: vi.fn(class {}),
}));

const baseConfig = (): ChatAgentConfig => ({
  chatId: 'chat',
  apiKey: 'test',
  model: 'test',
  callbacks: { sendMessage: vi.fn(), sendCard: vi.fn(), sendFile: vi.fn() },
});
const lastConfig = (): ChatAgentConfig => vi.mocked(ChatAgent).mock.calls.at(-1)![0];
const prompt = (config: ChatAgentConfig): string =>
  new MessageBuilder(config.messageBuilderOptions).buildEnhancedContent(
    { text: 'Research', messageId: 'm1' },
    config.chatId
  );

describe('Chat backend creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.defaultBackend = 'claude';
    vi.stubEnv('DISCLAUDE_ALLOW_BUILTIN_CRON', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['claude', 'codex', 'pi', 'deepseek'] as const)(
    'injects only the selected %s policies and preserves caller configuration',
    (agentBackend) => {
      const configureQueryOptions = vi.fn((options: AgentQueryOptions) => ({
        ...options,
        model: 'caller-model',
      }));
      const messageBuilderOptions = Object.freeze({
        buildHeader: () => 'Channel header',
        buildStableToolsSection: () => 'Stable channel instructions',
        buildToolsSection: () => 'Dynamic channel instructions',
      });
      const config = Object.freeze({
        ...baseConfig(),
        agentBackend,
        messageBuilderOptions,
        configureQueryOptions,
      });
      const agent = createChatAgent(config);
      const injected = lastConfig();
      const content = prompt(injected);
      expect(agent).toBeInstanceOf(ChatAgent);
      expect(content).toContain('Channel header');
      expect(content).toContain('Stable channel instructions');
      expect(content).toContain('Dynamic channel instructions');
      expect(content.includes('## Codex source citations')).toBe(agentBackend === 'codex');
      if (agentBackend !== 'codex') {
        expect(injected.messageBuilderOptions).toBe(messageBuilderOptions);
      }
      const options: AgentQueryOptions = {
        settingSources: ['user', 'project', 'local'],
        model: 'original-model',
        sessionKey: 'chat-session',
        tools: [],
        env: { EXAMPLE: 'safe' },
      };
      const queryOptions = injected.configureQueryOptions!(options);
      expect(configureQueryOptions).toHaveBeenCalledExactlyOnceWith(options);
      expect(queryOptions).toMatchObject({ ...options, model: 'caller-model' });
      expect(queryOptions.tools).toBe(options.tools);
      expect(queryOptions.env).toBe(options.env);
      expect(queryOptions).not.toHaveProperty('allowedTools');
      if (agentBackend === 'claude') {
        expect(queryOptions).toHaveProperty('disallowedTools', [
          'EnterPlanMode',
          'AskUserQuestion',
          'CronCreate',
          'CronList',
          'CronDelete',
          'ScheduleWakeup',
        ]);
      } else {
        expect(queryOptions).not.toHaveProperty('disallowedTools');
        expect(injected.configureQueryOptions).toBe(configureQueryOptions);
      }
      expect(options.model).toBe('original-model');
      expect(options).not.toHaveProperty('disallowedTools');
      expect(config.configureQueryOptions).toBe(configureQueryOptions);
    }
  );

  it('resolves the runtime default when no backend override or channel adapter is supplied', () => {
    runtime.defaultBackend = 'codex';
    createChatAgent(baseConfig());
    expect(getProvider).toHaveBeenCalledWith(undefined);
    expect(prompt(lastConfig())).toContain('## Codex source citations');
    expect(lastConfig().configureQueryOptions).toBeUndefined();
  });

  it('an explicit preset overrides the runtime default on each newly created agent', () => {
    runtime.defaultBackend = 'codex';
    createChatAgent({ ...baseConfig(), agentBackend: 'claude' });
    expect(prompt(lastConfig())).not.toContain('## Codex source citations');
    expect(lastConfig().configureQueryOptions).toBeTypeOf('function');
    createChatAgent({ ...baseConfig(), agentBackend: 'codex' });
    expect(prompt(lastConfig())).toContain('## Codex source citations');
    expect(lastConfig().configureQueryOptions).toBeUndefined();
  });

  it('rechecks the Claude cron opt-in for every new query', () => {
    createChatAgent({ ...baseConfig(), agentBackend: 'claude' });
    const configure = lastConfig().configureQueryOptions!;
    expect(configure({ settingSources: [] })).toHaveProperty(
      'disallowedTools',
      expect.arrayContaining(['CronCreate'])
    );
    vi.stubEnv('DISCLAUDE_ALLOW_BUILTIN_CRON', '1');
    expect(configure({ settingSources: [] })).toHaveProperty('disallowedTools', [
      'EnterPlanMode',
      'AskUserQuestion',
    ]);
  });
});
