import type { ReviewEvidence, TaskReviewDecision, TaskReviewRecord, TaskReviewStore, TaskSubmission, ToolDefinition } from '@disclaude/core';

export interface TaskReviewProposal { verdict: TaskReviewDecision['verdict']; reason: string; evidence: ReviewEvidence[] }
export interface TaskReviewCollection {
  readonly submissionId: string; readonly tool: ToolDefinition;
  read(): TaskReviewProposal | undefined;
  close(): void;
}

/** Proposal only; identity, target, native success and persistence stay host-owned. */
export function createTaskReviewReport(target: Readonly<TaskSubmission>, authorize: () => void | Promise<void>): TaskReviewCollection {
  const snapshot = structuredClone(target);
  let proposal: TaskReviewProposal | undefined, closed = false;
  return {
    submissionId: snapshot.id,
    tool: {
      name: 'board_review_report',
      description: 'Get this fixed submission and acceptance criteria, inspect the actual artifacts, then report one independent review. Evidence uses zero-based criterion indexes. This records a proposal; the host separately verifies native success, current bytes/revision and identity before saving. It does not complete the task.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['get', 'report'] }, verdict: { type: 'string', enum: ['changes-requested', 'approved'] },
        reason: { type: 'string', minLength: 1, maxLength: 16000 }, evidence: { type: 'array', maxItems: 100, items: {
          type: 'object', additionalProperties: false, required: ['criterion', 'note'], properties: {
            criterion: { type: 'integer', minimum: 0 }, note: { type: 'string', minLength: 1, maxLength: 4000 },
          },
        } },
      } },
      outputSchema: { type: 'object', additionalProperties: false, required: ['submissionId'], properties: {
        submissionId: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } },
        artifacts: { type: 'array', items: { type: 'object' } }, recorded: { type: 'boolean' }, nativeOutcomePending: { type: 'boolean' },
      } },
      execute: async (input, context) => {
        context.signal.throwIfAborted(); await authorize(); context.signal.throwIfAborted();
        if (closed) { throw new Error('Review collection has closed'); }
        if (input.action === 'get' && Object.keys(input).length === 1) {
          return { submissionId: snapshot.id, criteria: [...snapshot.criteria], artifacts: structuredClone(snapshot.artifacts) };
        }
        if (input.action !== 'report' || Object.keys(input).some(name => !['action', 'verdict', 'reason', 'evidence'].includes(name)) ||
          !['changes-requested', 'approved'].includes(input.verdict as string) || typeof input.reason !== 'string' ||
          !input.reason.trim() || input.reason.length > 16000 || !Array.isArray(input.evidence) || input.evidence.length > snapshot.criteria.length) {
          throw new Error('Invalid review proposal');
        }
        const seen = new Set<number>();
        for (const item of input.evidence) {
          if (!item || typeof item !== 'object' || Object.keys(item).some(name => !['criterion', 'note'].includes(name)) ||
            !Number.isSafeInteger(item.criterion) || item.criterion < 0 || item.criterion >= snapshot.criteria.length ||
            seen.has(item.criterion) || typeof item.note !== 'string' || !item.note.trim() || item.note.length > 4000) { throw new Error('Invalid review evidence'); }
          seen.add(item.criterion);
        }
        if (input.verdict === 'approved' && seen.size !== snapshot.criteria.length) { throw new Error('Approval must cover every acceptance criterion'); }
        const next: TaskReviewProposal = { verdict: input.verdict as TaskReviewProposal['verdict'], reason: input.reason,
          evidence: structuredClone(input.evidence as ReviewEvidence[]).sort((a, b) => a.criterion - b.criterion) };
        if (proposal && JSON.stringify(proposal) !== JSON.stringify(next)) { throw new Error('Review proposal already recorded; preserve it for reconciliation'); }
        proposal = next; return { submissionId: snapshot.id, recorded: true, nativeOutcomePending: true };
      },
    },
    read: () => proposal && structuredClone(proposal), close: () => { closed = true; },
  };
}

/** Retain and reuse the same actual handle/collection on a lost write ACK.
 * Reconciliation waits on its completed promise; it never starts a reviewer.
 */
export async function finalizeTaskReview(options: {
  store: Pick<TaskReviewStore, 'review'>; key: string; expectedRevision: number; collection: TaskReviewCollection;
  handle: { id: string; completion: Promise<{ id: string; outcome: string; truncated: boolean }> };
  authorize(): void | Promise<void>;
}): Promise<TaskReviewRecord> {
  const { collection, handle } = options;
  try {
    const native = await handle.completion;
    if (native.id !== handle.id || native.outcome !== 'succeeded' || native.truncated) { throw new Error('Review has no successful complete native execution'); }
    const proposal = collection.read(); if (!proposal) { throw new Error('Reviewer returned no structured proposal'); }
    await options.authorize();
    return await options.store.review(options.key, options.expectedRevision, { id: handle.id, reviewer: handle.id,
      submissionId: collection.submissionId, ...proposal });
  } finally { collection.close(); }
}
