/**
 * Cron-footgun mitigations for chat agents (Issue #4181).
 *
 * Claude Code's built-in CronCreate / CronList / CronDelete (and ScheduleWakeup)
 * create *session-only* tasks that die when the agent exits and auto-expire
 * after 7 days. Disclaude's file-based schedule (schedules/<slug>/SCHEDULE.md +
 * the `schedule` skill) is persistent across restarts and is the intended
 * mechanism for recurring work.
 *
 * Two complementary halves, both in this module:
 *
 * 1. **Mechanical (opt-in, part 1):** `buildDisallowedTools()` adds the built-in
 *    cron tools to the SDK disallowed-tools list when
 *    `DISCLAUDE_DISABLE_BUILTIN_CRON=1` (or `=true`, case-insensitive) is set.
 *    Disallowing stops the model from *calling* the tools but, by itself, does
 *    not route recurring work to the persistent `schedule` skill.
 * 2. **Behavioral (always-on, part 2):** `buildBuiltinCronGuidance()` returns a
 *    system-prompt nudge that tells the model the built-in cron tools are
 *    session-only and to use the persistent `schedule` skill for recurring
 *    work. This routes recurring work correctly *by default* (#4181), whether
 *    or not the mechanical block is enabled — the persistence fact holds either
 *    way, so the nudge is always emitted.
 *
 * @module primary-node/agents/disallowed-tools
 */

/** Tools always disallowed for chat agents. */
const BASE_DISALLOWED_TOOLS = ['EnterPlanMode', 'AskUserQuestion'] as const;

/**
 * Built-in tools that create *session-only* (non-persistent) work items,
 * disallowed only when the opt-in flag is set.
 *
 * `ScheduleWakeup` is the `/loop` dynamic-mode self-pacer rather than a cron
 * job, but is included here because it is likewise session-only — it dies when
 * the agent exits — so the same persistence rationale applies.
 */
const BUILTIN_CRON_TOOLS = ['CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup'] as const;

/** Truthy iff `value` is `1` or `true` (case-insensitive). */
function isTruthyFlag(value: string | undefined): boolean {
  return value?.toLowerCase() === '1' || value?.toLowerCase() === 'true';
}

/**
 * Build the disallowed-tools list for a chat agent.
 *
 * Always includes the base disallowed tools; additionally includes the built-in
 * cron tools when `DISCLAUDE_DISABLE_BUILTIN_CRON` is set to a truthy flag
 * (`1` or `true`, case-insensitive). `env` defaults to `process.env` but is
 * injectable for tests.
 */
export function buildDisallowedTools(env: NodeJS.ProcessEnv = process.env): string[] {
  const tools: string[] = [...BASE_DISALLOWED_TOOLS];
  if (isTruthyFlag(env.DISCLAUDE_DISABLE_BUILTIN_CRON)) {
    tools.push(...BUILTIN_CRON_TOOLS);
  }
  return tools;
}

/**
 * System-prompt guidance that routes recurring/scheduled work to disclaude's
 * persistent `schedule` skill and warns away from Claude Code's built-in
 * (session-only) cron tools (Issue #4181, part 2 — the behavioral companion to
 * `buildDisallowedTools`).
 *
 * The built-in CronCreate / CronList / CronDelete (and ScheduleWakeup) create
 * *session-only* tasks: they are not persisted, die when the agent exits, and
 * auto-expire after 7 days. Disclaude's file-based schedule
 * (schedules/<slug>/SCHEDULE.md + the `schedule` skill) is persistent across
 * restarts and is the intended mechanism. This nudge is always emitted — the
 * fact holds whether or not the tools are mechanically disallowed — so the
 * agent routes recurring work correctly by default per #4181.
 *
 * Intended to be appended to the chat agent's `claude_code` system prompt via
 * `SystemPromptPreset.append` (supported by the Claude Agent SDK and passed
 * through by the options adapter).
 *
 * @returns The guidance text to append to the system prompt.
 */
export function buildBuiltinCronGuidance(): string {
  return [
    '## Scheduled and recurring tasks',
    '',
    "Claude Code's built-in `CronCreate`, `CronList`, `CronDelete`, and `ScheduleWakeup` create **session-only** tasks: they are not written to disk, die when this agent exits, and auto-expire after 7 days. Do **not** use them for anything that must survive a restart or run unattended.",
    '',
    "For any recurring, periodic, scheduled, timer, or reminder work, use disclaude's persistent `schedule` skill instead. It writes `schedules/<slug>/SCHEDULE.md`, survives restarts, and supports full CRUD, `enabled`/`blocking` toggles, chat-scoped delivery, and model selection. Invoke it like any other skill (e.g. via `/schedule`). Prefer it by default whenever the user asks for something to happen on a schedule.",
  ].join('\n');
}
