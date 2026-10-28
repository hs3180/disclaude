import type { TaskReviewRecord, TaskReviewStore, ToolDefinition } from '@disclaude/core';

export interface TaskArtifactProposal { summary: string; refs: string[] }
export interface TaskArtifactCollection {
  readonly tool: ToolDefinition;
  read(): TaskArtifactProposal | undefined;
  close(): void;
}

/** A worker can propose artifact references, never its native identity or hashes.
 * The owning host pins the task, revision and actual completion handle.
 */
export function createTaskArtifactReport(criteria: readonly string[], authorize: () => void | Promise<void>): TaskArtifactCollection {
  if (!criteria.length || criteria.length > 100 || criteria.some(item => typeof item !== 'string' || !item.trim() || item.length > 4000)) {
    throw new Error('Artifact collection needs task acceptance criteria');
  }
  const snapshot = [...criteria];
  let proposal: TaskArtifactProposal | undefined, closed = false;
  return {
    tool: {
      name: 'board_artifacts_report',
      description: 'Read the fixed task criteria, then report the actual Project-relative files you produced and checked. One proposal is retained for native settlement. The host reads actual bytes/hashes and supplies the real worker identity before saving. This is a submission, not review approval or task completion.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['get', 'report'] }, summary: { type: 'string', minLength: 1, maxLength: 16000 },
        refs: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 2048 } },
      } },
      outputSchema: { type: 'object', additionalProperties: false, properties: {
        criteria: { type: 'array', items: { type: 'string' } }, recorded: { type: 'boolean' }, nativeOutcomePending: { type: 'boolean' },
      } },
      execute: async (input, context) => {
        context.signal.throwIfAborted(); await authorize(); context.signal.throwIfAborted();
        if (closed) { throw new Error('Artifact collection has closed'); }
        if (input.action === 'get' && Object.keys(input).length === 1) { return { criteria: [...snapshot] }; }
        if (input.action !== 'report' || Object.keys(input).some(name => !['action', 'summary', 'refs'].includes(name)) ||
            typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 16000 ||
            !Array.isArray(input.refs) || input.refs.length < 1 || input.refs.length > 100 ||
            input.refs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 2048) || new Set(input.refs).size !== input.refs.length) {
          throw new Error('Invalid artifact proposal');
        }
        const next: TaskArtifactProposal = { summary: input.summary, refs: [...input.refs as string[]].sort() };
        if (proposal && JSON.stringify(proposal) !== JSON.stringify(next)) { throw new Error('Artifact proposal already recorded; preserve it for reconciliation'); }
        proposal = next; return { recorded: true, nativeOutcomePending: true };
      },
    },
    read: () => proposal && structuredClone(proposal), close: () => { closed = true; },
  };
}

/** Keep the same actual handle/collection on an uncertain persistence ACK.
 * Retrying this finalizer never starts native work or takes model-supplied IDs.
 */
export async function finalizeTaskSubmission(options: {
  store: Pick<TaskReviewStore, 'submit'>; key: string; expectedRevision: number; collection: TaskArtifactCollection;
  handle: { id: string; completion: Promise<{ id: string; outcome: string; truncated: boolean }> };
  authorize(): void | Promise<void>;
}): Promise<TaskReviewRecord> {
  const { collection, handle } = options;
  try {
    const native = await handle.completion;
    if (native.id !== handle.id || native.outcome !== 'succeeded' || native.truncated) { throw new Error('Submission has no successful complete native execution'); }
    const proposal = collection.read(); if (!proposal) { throw new Error('Worker returned no structured artifact proposal'); }
    await options.authorize();
    return await options.store.submit(options.key, options.expectedRevision, { id: handle.id, submitter: handle.id, ...proposal });
  } finally { collection.close(); }
}
