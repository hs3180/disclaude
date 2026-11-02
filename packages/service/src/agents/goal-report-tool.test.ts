import { describe, expect, it } from 'vitest';
import type { GoalRecord } from '@disclaude/core';
import { prepareTools } from '../../../core/dist/sdk/tools.js';
import { createGoalReportTool } from './goal-report-tool.js';

const goal: GoalRecord = { version: 1, id: '00000000-0000-4000-8000-000000000000', revision: 2, status: 'active',
  chatId: 'chat', projectRoot: '/project', objective: 'Deliver a report', acceptance: ['Review the report', 'Verify results'],
  progress: '', artifacts: [], createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' };
const proposal = { outcome: 'completed', progress: 'Evidence recorded', artifacts: ['report.md', 'checks.log'],
  checks: [{ criterion: 0, satisfied: true, evidence: ['report.md'] }, { criterion: 1, satisfied: true, evidence: ['checks.log'] }] };
function fixture() {
  const collector = createGoalReportTool(structuredClone(goal));
  const [tool] = prepareTools([collector.tool]);
  const context = { signal: new AbortController().signal };
  return { collector, tool, context };
}
describe('native Goal assessment proposal', () => {
  it('captures evidence without claiming a durable save and detaches both input and returned values', async () => {
    const { collector, tool, context } = fixture(); const input = structuredClone(proposal);
    expect(await tool.execute(input, context)).toEqual({ accepted: true, saved: false, goalId: goal.id, revision: 2 });
    input.artifacts.length = 0; input.checks[0].evidence[0] = 'mutated';
    const report = collector.getReport()!; report.checks[0].evidence[0] = 'returned mutation';
    expect(collector.getReport()).toEqual(proposal);
  });
  it('refuses incomplete, duplicate and unrecorded completion evidence', async () => {
    const { collector, tool, context } = fixture();
    for (const input of [{ ...proposal, checks: [] }, { ...proposal, checks: proposal.checks.slice(0, 1) },
      { ...proposal, checks: [proposal.checks[0], proposal.checks[0]] },
      { ...proposal, checks: proposal.checks.map(check => ({ ...check, satisfied: false })) },
      { ...proposal, checks: proposal.checks.map(check => ({ ...check, evidence: [] })) },
      { ...proposal, checks: proposal.checks.map(check => ({ ...check, evidence: ['missing.log'] })) }]) {
      await expect(tool.execute(input, context)).rejects.toThrow(); expect(collector.getReport()).toBeUndefined();
    }
  });
  it('lets the model correct an invalid proposal before ending the round', async () => {
    const { collector, tool, context } = fixture();
    await expect(tool.execute({ ...proposal, checks: [] }, context)).rejects.toThrow();
    await tool.execute({ outcome: 'continue', progress: 'More work remains', artifacts: [], checks: [] }, context);
    await tool.execute(proposal, context); expect(collector.getReport()).toEqual(proposal);
  });
  it('keeps the host revision and Goal identity out of model arguments', async () => {
    const { tool, context, collector } = fixture();
    for (const input of [{ ...proposal, goalId: 'other' }, { ...proposal, revision: 99 },
      { ...proposal, checks: [{ criterion: 99, satisfied: true, evidence: ['report.md'] }] }]) {
      await expect(tool.execute(input, context)).rejects.toThrow();
    }
    expect(collector.getReport()).toBeUndefined();
  });
  it('rejects late or cancelled tool calls without changing the captured assessment', async () => {
    const { collector, tool, context } = fixture(); await tool.execute(proposal, context);
    const controller = new AbortController(); controller.abort();
    await expect(tool.execute({ ...proposal, progress: 'late' }, { signal: controller.signal })).rejects.toThrow();
    collector.close(); await expect(tool.execute({ ...proposal, progress: 'late' }, context)).rejects.toThrow('closed');
    expect(collector.getReport()).toEqual(proposal);
  });
  it('does not expose the reporting tool for an inactive Goal', () => {
    expect(() => createGoalReportTool({ ...goal, status: 'paused' })).toThrow('active');
  });
});
