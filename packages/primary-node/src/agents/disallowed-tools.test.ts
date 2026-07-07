/**
 * Tests for the chat-agent cron-footgun mitigations (Issue #4181).
 */

import { describe, it, expect } from 'vitest';
import { buildBuiltinCronGuidance, buildDisallowedTools } from './disallowed-tools.js';

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

describe('buildBuiltinCronGuidance', () => {
  it('returns a non-empty string', () => {
    const guidance = buildBuiltinCronGuidance();
    expect(typeof guidance).toBe('string');
    expect(guidance.length).toBeGreaterThan(0);
  });

  it('is stable across calls (no env / randomness dependency)', () => {
    expect(buildBuiltinCronGuidance()).toBe(buildBuiltinCronGuidance());
  });

  it('warns that the built-in cron tools are session-only', () => {
    const guidance = buildBuiltinCronGuidance();
    expect(guidance).toContain('session-only');
    for (const tool of ['CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup']) {
      expect(guidance).toContain(tool);
    }
  });

  it('routes recurring work to the persistent schedule skill', () => {
    const guidance = buildBuiltinCronGuidance();
    expect(guidance).toContain('`schedule` skill');
    expect(guidance).toContain('SCHEDULE.md');
    expect(guidance).toMatch(/persistent|survives restart/i);
  });

  it('is always emitted regardless of DISCLAUDE_DISABLE_BUILTIN_CRON', () => {
    // Part 2 is behavioral guidance, not gated by the part-1 opt-in flag.
    const original = process.env.DISCLAUDE_DISABLE_BUILTIN_CRON;
    try {
      process.env.DISCLAUDE_DISABLE_BUILTIN_CRON = '1';
      const on = buildBuiltinCronGuidance();
      delete process.env.DISCLAUDE_DISABLE_BUILTIN_CRON;
      const off = buildBuiltinCronGuidance();
      expect(on).toBe(off);
      expect(on.length).toBeGreaterThan(0);
    } finally {
      if (original === undefined) {
        delete process.env.DISCLAUDE_DISABLE_BUILTIN_CRON;
      } else {
        process.env.DISCLAUDE_DISABLE_BUILTIN_CRON = original;
      }
    }
  });
});
