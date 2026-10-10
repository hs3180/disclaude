import { describe, expect, it, vi } from 'vitest';
import {
  MessageBuilder,
  type MessageBuilderOptions,
} from '../../../agents/message-builder/index.js';
import { DEFAULT_CHANNEL_CAPABILITIES } from '../../../types/channel.js';
import type { AgentQueryOptions } from '../../types.js';
import { CodexAgentProvider } from './provider.js';
import { withCodexSourceCitations } from './source-citations.js';

describe('Codex source guidance composition', () => {
  it('keeps the source contract on channels without cards', () => {
    const provider = new CodexAgentProvider({ env: {}, builtinsDir: process.cwd() });
    const hooks = provider.configureChat({});
    provider.dispose();
    const builder = new MessageBuilder(hooks.messageBuilderOptions);
    const prompt = builder.buildEnhancedContent({ text: 'Research', messageId: 'm1' }, 'chat', {
      ...DEFAULT_CHANNEL_CAPABILITIES,
      supportsCard: false,
      supportedChannelTools: ['send_text'],
    });

    expect(prompt).toContain('numbered markers such as [1] and [2]');
    expect(prompt).toContain('number. [title](direct URL)');
    expect(prompt).toContain(
      'Only cite a claim when the source content you actually read supports it.'
    );
    expect(prompt).toContain(
      'When a claim comes from a linked page, read that page and cite its own title and direct URL.'
    );
    expect(prompt).toContain(
      'If evidence is missing, omit the claim or say it remains unverified.'
    );
    expect(prompt).toContain('Label your inferences and cite the evidence behind them.');
    expect(prompt).toContain('Do not add a `## Sources` section when the answer has no citations');
    expect(prompt).toContain(
      'Do not call `send_card` or `send_interactive` for these citation sources'
    );
    expect(prompt).toContain('do not write card JSON');
  });

  it('composes chat prompts through the provider without replacing the query hook', () => {
    const provider = new CodexAgentProvider({ env: {}, builtinsDir: process.cwd() });
    const configureQueryOptions = (options: AgentQueryOptions) => options;
    const hooks = Object.freeze({
      messageBuilderOptions: Object.freeze({ buildHeader: () => 'Channel header' }),
      configureQueryOptions,
    });
    const configured = provider.configureChat(hooks);
    provider.dispose();

    const prompt = new MessageBuilder(configured.messageBuilderOptions).buildEnhancedContent(
      { text: 'Research', messageId: 'm1' },
      'chat'
    );
    expect(prompt).toContain('Channel header');
    expect(prompt).toContain('## Codex source citations');
    expect(configured.configureQueryOptions).toBe(configureQueryOptions);
    expect(configured.messageBuilderOptions).not.toBe(hooks.messageBuilderOptions);
  });

  it('preserves channel callbacks and does not mutate shared options', () => {
    const stable = vi.fn(() => 'Stable channel instructions');
    const options = Object.freeze<MessageBuilderOptions>({
      buildHeader: () => 'Channel header',
      buildStableToolsSection: stable,
      buildToolsSection: (ctx) => `Channel tools for ${ctx.chatId}`,
    });
    const composed = withCodexSourceCitations(options);
    const capabilities = { ...DEFAULT_CHANNEL_CAPABILITIES };
    const prompt = new MessageBuilder(composed).buildEnhancedContent(
      {
        text: 'Research',
        messageId: 'm1',
      },
      'chat',
      capabilities
    );

    expect(prompt).toContain('Channel header');
    expect(prompt).toContain('Stable channel instructions');
    expect(prompt).toContain('Channel tools for chat');
    expect(stable).toHaveBeenCalledWith({ capabilities });
    expect(options.buildStableToolsSection).toBe(stable);
    expect(
      new MessageBuilder(options).buildEnhancedContent(
        {
          text: 'Research',
          messageId: 'm1',
        },
        'chat'
      )
    ).not.toContain('## Codex source citations');
  });

  it('puts source guidance in the stable prefix across different messages', () => {
    const builder = new MessageBuilder(withCodexSourceCitations());
    const first = builder.buildSections({ text: 'First question', messageId: 'm1' }, 'chat-1');
    const second = builder.buildSections({ text: 'Next question', messageId: 'm2' }, 'chat-2');
    const source = first.find((section) => section.content.includes('## Codex source citations'));

    expect(source?.stability).toBe('stable');
    expect(second.find((section) => section.content.includes('## Codex source citations'))).toEqual(
      source
    );
    expect(first.indexOf(source!)).toBeLessThan(
      first.findIndex((section) => section.stability === 'dynamic')
    );
    expect(source?.content).not.toContain('chat-1');
    expect(source?.content).not.toContain('First question');
  });

  it('preserves minimal skill prompts and their injected context', () => {
    const builder = new MessageBuilder(
      withCodexSourceCitations({
        buildSkillCommandExtra: () => 'Skill context',
      })
    );
    const prompt = builder.buildEnhancedContent({ text: '/research', messageId: 'm1' }, 'chat');

    expect(prompt).toContain('/research');
    expect(prompt).toContain('Skill context');
    expect(prompt).not.toContain('## Codex source citations');
  });
});
