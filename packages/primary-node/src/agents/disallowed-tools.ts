/**
 * Disallowed-tools list builder for chat agents (Issue #4181).
 *
 * Claude Code's built-in CronCreate / CronList / CronDelete (and ScheduleWakeup)
 * create *session-only* tasks that die when the agent exits and auto-expire
 * after 7 days. Disclaude's file-based schedule (schedules/<slug>/SCHEDULE.md +
 * the `schedule` skill) is persistent across restarts and is the intended
 * mechanism for recurring work.
 *
 * These built-in tools are therefore disallowed for chat agents **by default**.
 * Set `DISCLAUDE_ALLOW_BUILTIN_CRON=1` (or `=true`, case-insensitive) to restore
 * them — e.g. for ad-hoc use of Claude Code's built-in `/loop` dynamic mode
 * (which relies on ScheduleWakeup).
 *
 * Note: disallowing the tools stops the model from *calling* them but does not,
 * by itself, route recurring work to the persistent `schedule` skill — that
 * reroute needs a guidance/system-prompt nudge, tracked as a follow-up to
 * #4181. Disallowing by default is the mechanical half of that change.
 *
 * @module primary-node/agents/disallowed-tools
 */

/** Tools always disallowed for chat agents. */
const BASE_DISALLOWED_TOOLS = ['EnterPlanMode', 'AskUserQuestion'] as const;

/**
 * Built-in tools that create *session-only* (non-persistent) work items,
 * disallowed by default (see `DISCLAUDE_ALLOW_BUILTIN_CRON` to re-enable).
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
 * Always includes the base disallowed tools. The built-in (session-only)
 * cron/loop tools are **also included by default**; set
 * `DISCLAUDE_ALLOW_BUILTIN_CRON` to a truthy flag (`1` or `true`,
 * case-insensitive) to restore them. `env` defaults to `process.env` but is
 * injectable for tests.
 */
export function buildDisallowedTools(env: NodeJS.ProcessEnv = process.env): string[] {
  const tools: string[] = [...BASE_DISALLOWED_TOOLS];
  if (!isTruthyFlag(env.DISCLAUDE_ALLOW_BUILTIN_CRON)) {
    tools.push(...BUILTIN_CRON_TOOLS);
  }
  return tools;
}
