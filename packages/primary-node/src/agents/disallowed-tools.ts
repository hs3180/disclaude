/**
 * Disallowed-tools list builder for chat agents (Issue #4181).
 *
 * Claude Code's built-in CronCreate / CronList / CronDelete (and ScheduleWakeup)
 * create *session-only* tasks that die when the agent exits and auto-expire
 * after 7 days. Disclaude's file-based schedule (schedules/<slug>/SCHEDULE.md +
 * the `schedule` skill) is persistent across restarts and is the intended
 * mechanism for recurring work.
 *
 * Set `DISCLAUDE_DISABLE_BUILTIN_CRON=1` (or `=true`, case-insensitive) to
 * disallow these built-in tools for chat agents.
 *
 * Note: disallowing the tools stops the model from *calling* them but does not,
 * by itself, route recurring work to the persistent `schedule` skill — that
 * reroute needs a guidance/system-prompt nudge, tracked as a follow-up to
 * #4181. This flag is the mechanical half of that change.
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
