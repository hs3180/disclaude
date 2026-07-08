/**
 * Tests for the chat-agent disallowed-tools builder (Issue #4181).
 */

import { describe, it, expect } from 'vitest';
import { buildDisallowedTools, buildBuiltinCronGuidance } from './disallowed-tools.js';

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

describe('buildBuiltinCronGuidance', () => {
  it('returns guidance routing to the schedule skill by default (issue #4181 part 2)', () => {
    const guidance = buildBuiltinCronGuidance({});
    expect(typeof guidance).toBe('string');
    expect(guidance).toMatch(/schedule/);
    // Mentions the built-in tools it supersedes so the model knows not to use them.
    expect(guidance).toMatch(/CronCreate/);
    expect(guidance).toMatch(/ScheduleWakeup/);
    // Points at the persistent file location.
    expect(guidance).toMatch(/workspace\/schedules/);
  });

  it('returns undefined when built-in cron tools are re-enabled', () => {
    expect(buildBuiltinCronGuidance({ DISCLAUDE_ALLOW_BUILTIN_CRON: '1' })).toBeUndefined();
    expect(buildBuiltinCronGuidance({ DISCLAUDE_ALLOW_BUILTIN_CRON: 'true' })).toBeUndefined();
  });

  it('returns guidance for falsy/other flag values', () => {
    for (const value of ['0', 'false', '', 'yes', 'allow']) {
      expect(buildBuiltinCronGuidance({ DISCLAUDE_ALLOW_BUILTIN_CRON: value })).toBeDefined();
    }
  });
});
