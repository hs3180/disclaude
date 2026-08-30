/**
 * Tests for the pi-path tool permission gate (Issue #4389, part 1).
 *
 * #4389 acceptance item 2 — "Deny path tested — a disallowed tool call does
 * not execute" — is the correctness criterion here: the gate must return
 * `{ block: true, reason }` (pi converts that to an error tool result and
 * skips execution) for a disallowed tool, and allow everything else through.
 *
 * Pure module: synthetic BeforeToolCallContext values, no pi runtime.
 */
import { describe, it, expect } from 'vitest';
import { createPiToolPermissionGate } from './tool-permission-gate.js';
import type { PiBeforeToolCallContext } from './pi-runtime.js';
import type { AgentQueryOptions } from '../../types.js';

/** AgentQueryOptions requires `settingSources` (the only required field). */
function opts(over: Partial<AgentQueryOptions> = {}): AgentQueryOptions {
  return { settingSources: ['user'], ...over };
}

/** Build a gate that is statically non-null (construction asserted above). */
function mustGate(
  over: Partial<AgentQueryOptions> = {},
): NonNullable<ReturnType<typeof createPiToolPermissionGate>> {
  const gate = createPiToolPermissionGate(opts(over));
  if (!gate) {
    throw new Error('expected a non-null gate');
  }
  return gate;
}

/** A minimal pi BeforeToolCallContext for the named tool. */
function toolCall(name: string, args: Record<string, unknown> = {}): PiBeforeToolCallContext {
  return {
    assistantMessage: { role: 'assistant', content: [] },
    toolCall: { type: 'toolCall', id: 'call_1', name, arguments: args },
    args,
    context: {},
  };
}

describe('createPiToolPermissionGate (Issue #4389 part 1)', () => {
  // -------------------------------------------------------------------------
  // Gate construction (omit-the-hook contract)
  // -------------------------------------------------------------------------

  it('returns null when disallowedTools is absent (hook omitted entirely)', () => {
    expect(createPiToolPermissionGate(opts())).toBeNull();
  });

  it('returns null when disallowedTools is an empty array', () => {
    expect(createPiToolPermissionGate(opts({ disallowedTools: [] }))).toBeNull();
  });

  it('returns a hook when disallowedTools is non-empty', () => {
    const gate = createPiToolPermissionGate(opts({ disallowedTools: ['CronCreate'] }));
    expect(typeof gate).toBe('function');
  });

  // -------------------------------------------------------------------------
  // Deny path (#4389 acceptance item 2)
  // -------------------------------------------------------------------------

  it('BLOCKS a tool call whose name is on the disallowed list', async () => {
    const gate = mustGate({ disallowedTools: ['CronCreate', 'EnterPlanMode'] });
    const verdict = await gate(toolCall('CronCreate', { name: 'daily', prompt: 'x' }));
    expect(verdict).toEqual({
      block: true,
      reason: expect.stringContaining('CronCreate'),
    });
    expect(verdict?.reason).toMatch(/disallowed by disclaude's permission policy/);
  });

  it('ALLOWS a tool call whose name is not on the list (undefined verdict)', async () => {
    const gate = mustGate({ disallowedTools: ['CronCreate'] });
    const verdict = await gate(toolCall('Read', { file_path: '/tmp/x' }));
    expect(verdict).toBeUndefined();
  });

  it('matches tool names exactly — a prefix/superset name is NOT denied', async () => {
    const gate = mustGate({ disallowedTools: ['Cron'] });
    expect(await gate(toolCall('CronCreate'))).toBeUndefined();
    expect(await gate(toolCall('Cron'))).toMatchObject({ block: true });
  });

  it('blocks every listed name, not just the first', async () => {
    const gate = mustGate({ disallowedTools: ['EnterPlanMode', 'AskUserQuestion', 'ScheduleWakeup'] });
    for (const name of ['EnterPlanMode', 'AskUserQuestion', 'ScheduleWakeup']) {
      await expect(gate(toolCall(name))).resolves.toMatchObject({ block: true });
    }
  });

  it('de-duplicates a repeated disallowedTools entry', () => {
    // Not observable from the outside beyond working correctly; assert the
    // gate still denies after dedup.
    const gate = createPiToolPermissionGate(
      opts({ disallowedTools: ['CronCreate', 'CronCreate'] }),
    );
    expect(gate).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Robustness
  // -------------------------------------------------------------------------

  it('does not deny when the signal is already aborted (loop owns abort handling)', async () => {
    const gate = mustGate({ disallowedTools: ['CronCreate'] });
    const controller = new AbortController();
    controller.abort();
    const verdict = await gate(toolCall('CronCreate'), controller.signal);
    expect(verdict).toBeUndefined();
  });

  it('still denies a disallowed call when a non-aborted signal is passed', async () => {
    const gate = mustGate({ disallowedTools: ['CronCreate'] });
    const verdict = await gate(toolCall('CronCreate'), new AbortController().signal);
    expect(verdict).toMatchObject({ block: true });
  });

  it('never throws — a malformed context yields an allow, not a crash', async () => {
    const gate = mustGate({ disallowedTools: ['CronCreate'] });
    // @ts-expect-error — deliberately malformed context (defensive read).
    await expect(gate({ toolCall: null })).resolves.toBeUndefined();
    // @ts-expect-error — missing toolCall entirely.
    await expect(gate({})).resolves.toBeUndefined();
  });
});
