/**
 * Tests for the chat-agent disallowed-tools builder (Issue #4181).
 */

import { describe, it, expect } from 'vitest';
import { buildDisallowedTools } from './disallowed-tools.js';

describe('buildDisallowedTools', () => {
  it('returns the base disallowed tools when the flag is unset', () => {
    expect(buildDisallowedTools({})).toEqual(['EnterPlanMode', 'AskUserQuestion']);
  });

  it('appends built-in cron tools when DISCLAUDE_DISABLE_BUILTIN_CRON=1', () => {
    const tools = buildDisallowedTools({ DISCLAUDE_DISABLE_BUILTIN_CRON: '1' });
    expect(tools).toEqual([
      'EnterPlanMode',
      'AskUserQuestion',
      'CronCreate',
      'CronList',
      'CronDelete',
      'ScheduleWakeup',
    ]);
  });

  it('appends built-in cron tools when DISCLAUDE_DISABLE_BUILTIN_CRON=true', () => {
    expect(buildDisallowedTools({ DISCLAUDE_DISABLE_BUILTIN_CRON: 'true' })).toEqual([
      'EnterPlanMode',
      'AskUserQuestion',
      'CronCreate',
      'CronList',
      'CronDelete',
      'ScheduleWakeup',
    ]);
  });

  it('treats the flag case-insensitively', () => {
    for (const value of ['True', 'TRUE', 'tRuE']) {
      expect(buildDisallowedTools({ DISCLAUDE_DISABLE_BUILTIN_CRON: value })).toContain('CronCreate');
    }
  });

  it('does not append cron tools for falsy/other values', () => {
    for (const value of ['0', 'false', '', 'yes', 'disabled']) {
      expect(buildDisallowedTools({ DISCLAUDE_DISABLE_BUILTIN_CRON: value })).toEqual([
        'EnterPlanMode',
        'AskUserQuestion',
      ]);
    }
  });
});
