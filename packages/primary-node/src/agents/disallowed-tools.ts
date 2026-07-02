/**
 * Disallowed-tools list builder for chat agents (Issue #4181).
 *
 * Claude Code's built-in cron tools — CronCreate / CronList / CronDelete /
 * ScheduleWakeup — create *session-only* tasks that die when the agent exits
 * and auto-expire after 7 days. Disclaude's file-based schedule
 * (schedules/<slug>/SCHEDULE.md + the `schedule` skill) is persistent across
 * restarts and is the intended mechanism for recurring work.
 *
 * Set `DISCLAUDE_DISABLE_BUILTIN_CRON=1` (or `=true`) to disallow the built-in
 * cron tools for chat agents, so recurring tasks route through the persistent
 * disclaude schedule instead.
 *
 * @module primary-node/agents/disallowed-tools
 */

/** Tools always disallowed for chat agents. */
const BASE_DISALLOWED_TOOLS = ['EnterPlanMode', 'AskUserQuestion'] as const;

/** Built-in cron tools, disallowed only when the opt-in flag is set. */
const BUILTIN_CRON_TOOLS = ['CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup'] as const;

function isTruthyFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/**
 * Build the disallowed-tools list for a chat agent.
 *
 * Always includes the base disallowed tools; additionally includes the built-in
 * cron tools when `DISCLAUDE_DISABLE_BUILTIN_CRON` is set to a truthy flag
 * (`1` or `true`). `env` defaults to `process.env` but is injectable for tests.
 */
export function buildDisallowedTools(env: NodeJS.ProcessEnv = process.env): string[] {
  const tools: string[] = [...BASE_DISALLOWED_TOOLS];
  if (isTruthyFlag(env.DISCLAUDE_DISABLE_BUILTIN_CRON)) {
    tools.push(...BUILTIN_CRON_TOOLS);
  }
  return tools;
}
