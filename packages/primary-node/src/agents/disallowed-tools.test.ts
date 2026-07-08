/**
 * Tests for the chat-agent disallowed-tools builder (Issue #4181).
 */

import { describe, it, expect } from 'vitest';
import { buildDisallowedTools } from './disallowed-tools.js';

describe('buildDisallowedTools', () => {
  it('disallows the built-in cron tools by default (issue #4181)', () => {
    expect(buildDisallowedTools({})).toEqual([
      'EnterPlanMode',
      'AskUserQuestion',
      'CronCreate',
      'CronList',
      'CronDelete',
      'ScheduleWakeup',
    ]);
  });

  it('restores the built-in cron tools when DISCLAUDE_ALLOW_BUILTIN_CRON=1', () => {
    expect(buildDisallowedTools({ DISCLAUDE_ALLOW_BUILTIN_CRON: '1' })).toEqual([
      'EnterPlanMode',
      'AskUserQuestion',
    ]);
  });

  it('restores the built-in cron tools when DISCLAUDE_ALLOW_BUILTIN_CRON=true', () => {
    expect(buildDisallowedTools({ DISCLAUDE_ALLOW_BUILTIN_CRON: 'true' })).toEqual([
      'EnterPlanMode',
      'AskUserQuestion',
    ]);
  });

  it('treats the flag case-insensitively', () => {
    for (const value of ['True', 'TRUE', 'tRuE']) {
      expect(buildDisallowedTools({ DISCLAUDE_ALLOW_BUILTIN_CRON: value })).not.toContain('CronCreate');
    }
  });

  it('keeps disallowing the cron tools for falsy/other values', () => {
    for (const value of ['0', 'false', '', 'yes', 'allow']) {
      expect(buildDisallowedTools({ DISCLAUDE_ALLOW_BUILTIN_CRON: value })).toEqual([
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
