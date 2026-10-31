import type { GoalRecord, ToolDefinition } from '@disclaude/core';

/** Native proposal; structurally matches the Goal store's settled-turn report. */
export interface NativeGoalReport {
  outcome: 'continue' | 'blocked' | 'completed';
  progress: string;
  artifacts: string[];
  checks: Array<{ criterion: number; satisfied: boolean; evidence: string[] }>;
}

/** Collect a proposal for this exact revision without prematurely persisting it. */
export function createGoalReportTool(goal: Readonly<GoalRecord>): {
  tool: ToolDefinition; getReport(): NativeGoalReport | undefined; close(): void;
} {
  if (goal.status !== 'active' || !goal.acceptance.length) { throw new Error('Goal report needs an active requirements revision'); }
  const { id, revision } = goal;
  const count = goal.acceptance.length;
  let report: NativeGoalReport | undefined;
  let closed = false;
  const references = { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 2000 } };
  return {
    tool: {
      name: 'goal_report',
      description: 'Propose this round’s Goal assessment. The host saves it only after all native work settles successfully. Use recorded artifact references as evidence; completed must cover every criterion.',
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { outcome: { type: 'string', enum: ['continue', 'blocked', 'completed'] },
          progress: { type: 'string', minLength: 1, maxLength: 16000 }, artifacts: references,
          checks: { type: 'array', maxItems: count, items: { type: 'object', additionalProperties: false,
            properties: { criterion: { type: 'integer', minimum: 0, maximum: count - 1 }, satisfied: { type: 'boolean' }, evidence: references },
            required: ['criterion', 'satisfied', 'evidence'] } } }, required: ['outcome', 'progress', 'artifacts', 'checks'] },
      outputSchema: { type: 'object', additionalProperties: false,
        properties: { accepted: { type: 'boolean' }, saved: { type: 'boolean' }, goalId: { type: 'string' }, revision: { type: 'integer' } },
        required: ['accepted', 'saved', 'goalId', 'revision'] },
      execute: (input, context) => {
        context.signal.throwIfAborted();
        if (closed) { return Promise.reject(new Error('Goal assessment collection is closed')); }
        // Harness schema validation runs before this business-level coverage check.
        const proposal = input as unknown as NativeGoalReport;
        const indices = new Set<number>();
        for (const check of proposal.checks) {
          if (indices.has(check.criterion) || (check.satisfied && check.evidence.length === 0) ||
              check.evidence.some(item => !proposal.artifacts.includes(item))) {
            return Promise.reject(new Error('Acceptance checks need unique criteria and recorded evidence'));
          }
          indices.add(check.criterion);
        }
        if (!proposal.progress.trim() || proposal.artifacts.some(item => !item.trim()) ||
            (proposal.outcome === 'completed' && (indices.size !== count || proposal.checks.some(check => !check.satisfied)))) {
          return Promise.reject(new Error('Goal completion requires evidence for every current acceptance condition'));
        }
        report = structuredClone(proposal);
        return Promise.resolve({ accepted: true, saved: false, goalId: id, revision });
      },
    },
    getReport: () => report && structuredClone(report),
    close: () => { closed = true; },
  };
}
