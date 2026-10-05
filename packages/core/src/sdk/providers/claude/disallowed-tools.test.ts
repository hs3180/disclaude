/**
 * Tests for the chat-agent disallowed-tools builder (Issue #4181).
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import type { AgentQueryOptions } from '../../types.js';
import { ClaudeSDKProvider } from './provider.js';
import { buildClaudeDisallowedTools } from './disallowed-tools.js';

describe('buildClaudeDisallowedTools', () => {
  it('disallows the built-in cron tools by default (issue #4181)', () => {
    expect(buildClaudeDisallowedTools({})).toEqual([
      'EnterPlanMode',
      'AskUserQuestion',
      'CronCreate',
      'CronList',
      'CronDelete',
      'ScheduleWakeup',
    ]);
  });

  it('restores the built-in cron tools when DISCLAUDE_ALLOW_BUILTIN_CRON=1', () => {
    expect(buildClaudeDisallowedTools({ DISCLAUDE_ALLOW_BUILTIN_CRON: '1' })).toEqual([
      'EnterPlanMode',
      'AskUserQuestion',
    ]);
  });

  it('restores the built-in cron tools when DISCLAUDE_ALLOW_BUILTIN_CRON=true', () => {
    expect(buildClaudeDisallowedTools({ DISCLAUDE_ALLOW_BUILTIN_CRON: 'true' })).toEqual([
      'EnterPlanMode',
      'AskUserQuestion',
    ]);
  });

  it('treats the flag case-insensitively', () => {
    for (const value of ['True', 'TRUE', 'tRuE']) {
      expect(buildClaudeDisallowedTools({ DISCLAUDE_ALLOW_BUILTIN_CRON: value })).not.toContain('CronCreate');
    }
  });

  it('keeps disallowing the cron tools for falsy/other values', () => {
    for (const value of ['0', 'false', '', 'yes', 'allow']) {
      expect(buildClaudeDisallowedTools({ DISCLAUDE_ALLOW_BUILTIN_CRON: value })).toEqual([
        'EnterPlanMode',
        'AskUserQuestion',
        'CronCreate',
        'CronList',
        'CronDelete',
        'ScheduleWakeup',
      ]);
    }
  });
});

describe('Claude chat configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('composes native permissions with caller hooks and preserves common query options', () => {
    vi.stubEnv('DISCLAUDE_ALLOW_BUILTIN_CRON', '');
    const messageBuilderOptions = Object.freeze({ buildHeader: () => 'Channel header' });
    const configureQueryOptions = vi.fn((options: AgentQueryOptions) => ({
      ...options,
      model: 'caller-model',
    }));
    const hooks = Object.freeze({ messageBuilderOptions, configureQueryOptions });
    const configured = new ClaudeSDKProvider().configureChat(hooks);
    const options = Object.freeze<AgentQueryOptions>({
      settingSources: ['user', 'project', 'local'],
      model: 'original-model',
      sessionKey: 'chat-session',
      tools: [],
      env: { EXAMPLE: 'safe' },
      onUserInput: vi.fn(),
    });
    const queryOptions = configured.configureQueryOptions!(options);

    expect(configureQueryOptions).toHaveBeenCalledExactlyOnceWith(options);
    expect(queryOptions).toMatchObject({ ...options, model: 'caller-model' });
    expect(queryOptions.tools).toBe(options.tools);
    expect(queryOptions.env).toBe(options.env);
    expect(queryOptions.onUserInput).toBe(options.onUserInput);
    expect(queryOptions).not.toHaveProperty('allowedTools');
    expect(queryOptions).toHaveProperty('disallowedTools', buildClaudeDisallowedTools({}));
    expect(configured.messageBuilderOptions).toBe(messageBuilderOptions);
    expect(options.model).toBe('original-model');
    expect(options).not.toHaveProperty('disallowedTools');
    expect(hooks.configureQueryOptions).toBe(configureQueryOptions);
  });

  it('rechecks the cron opt-in per query when no caller hooks are supplied', () => {
    vi.stubEnv('DISCLAUDE_ALLOW_BUILTIN_CRON', '');
    const configured = new ClaudeSDKProvider().configureChat({});
    const configure = configured.configureQueryOptions!;

    expect(configured.messageBuilderOptions).toBeUndefined();
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
