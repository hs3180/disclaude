import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TaskAdmissionStore, TaskClaimStore, TaskResultOutbox, TaskReviewStore, readProjectArtifact,
  type TaskReviewRecord, type ToolDefinition } from '@disclaude/core';
import { AgentTaskRunner, type AgentTaskHandle, type AgentTaskResult } from '../agents/agent-task-runner.js';
import { prepareDurableClaimedTask } from '../agents/claimed-task-admission.js';
import { createTaskArtifactReport, finalizeTaskSubmission, type TaskArtifactCollection } from '../agents/task-artifact-report.js';
import { createTaskReviewReport, finalizeTaskReview, type TaskReviewCollection } from '../agents/task-review-report.js';
import type { NativeGoalTurnTools } from '../agents/native-goal-executor.js';
import type { GoalTurnToolScope } from './goal-execution-service.js';
import { createGoalTaskTurnTools } from './goal-task-tools.js';
import { createLarkTaskBoardPort, type LarkTaskBoardCoordinates } from './lark-task-board-port.js';
import { TaskBoardProjection, type TaskBoardPort, type TaskBoardRecord } from './task-board-projection.js';

const field = { task: '任务 ID', goal: 'Goal ID', criteria: '验收要求', owner: '负责人', status: '状态', artifacts: '产物', review: 'Review 依据' };
const fields = Object.values(field);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
interface Request { action: 'execute' | 'review' | 'get' | 'release'; operationId: string; taskId: string;
  target: LarkTaskBoardCoordinates; task?: string; submissionId?: string }
interface SavedProposal { kind: 'execute' | 'review'; expectedRevision: number; submissionId?: string; proposal: unknown }
interface Job { fingerprint: string; flight?: Promise<Record<string, unknown>>; native?: AgentTaskHandle; settled?: Promise<AgentTaskResult> }
function request(input: Record<string, unknown>): Request {
  const target = input.target as LarkTaskBoardCoordinates | undefined;
  if (Object.keys(input).some(key => !['action', 'operationId', 'taskId', 'target', 'task', 'submissionId'].includes(key)) ||
      !['execute', 'review', 'get', 'release'].includes(input.action as string) ||
      ![input.operationId, input.taskId].every(value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) ||
      !target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['baseToken', 'tableId', 'recordId'].includes(key)) ||
      ![target.baseToken, target.tableId, target.recordId].every(value => typeof value === 'string' && /^[a-zA-Z0-9_]{1,512}$/.test(value)) ||
      !target.tableId.startsWith('tbl') || !target.recordId.startsWith('rec') ||
      (input.task !== undefined && (typeof input.task !== 'string' || !input.task.trim() || input.task.length > 64000)) ||
      (input.action === 'execute' && !input.task) ||
      (input.action === 'review' && (typeof input.submissionId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.submissionId)))) {
    throw new Error('Invalid Goal board task request');
  }
  return structuredClone(input) as unknown as Request;
}

/** Compose existing independent components. The main Goal agent maintains its
 * Base through the ordinary lark skill; this tool owns only a known task record.
 */
export function createGoalBoardTurnTools(scope: GoalTurnToolScope, directory: string, options: {
  boardPort?(target: LarkTaskBoardCoordinates): TaskBoardPort;
} = {}): NativeGoalTurnTools {
  const sync = createGoalTaskTurnTools(scope), claims = new TaskClaimStore(join(directory, 'claims'));
  const admissions = new TaskAdmissionStore(join(directory, 'admissions')), outbox = new TaskResultOutbox(join(directory, 'results'));
  const reviews = new TaskReviewStore(join(directory, 'reviews'), ref => readProjectArtifact(scope.source.projectRoot, ref));
  const jobs = new Map<string, Job>(), runners = new Set<AgentTaskRunner>(), completionChecks = new Map<string, () => Promise<void>>();
  let closed = false, closing: Promise<void> | undefined;
  const authorize = async (): Promise<void> => { if (closed) { throw new Error('Goal board tools are closed'); } await scope.authorize(); };
  const identify = (record: TaskBoardRecord, input: Request): string => {
    const criteria = record.fields[field.criteria];
    if (record.recordId !== input.target.recordId || record.fields[field.task] !== input.taskId || record.fields[field.goal] !== scope.goal.id ||
        typeof criteria !== 'string' || !criteria.trim() || criteria.length > 16000) { throw new Error('Board task does not match this Goal, task or acceptance requirements'); }
    return criteria;
  };
  const approval = async (key: string, record?: TaskReviewRecord): Promise<boolean> => {
    if (!record) { return false; } try { await reviews.verifyApproved(key, record.revision); return true; } catch { return false; }
  };
  const tool: ToolDefinition = {
    name: 'goal_board_task',
    description: 'Execute or independently review one existing Base record in this Goal, or get/release its known operation. First maintain the board with the ordinary lark-base skill and docs/task-board.md field template. Task ID and Goal ID must match; acceptance is read from the real record. execute requires task; review requires the actual submissionId returned by execute. Use a new operationId for distinct work/repair/review, and reuse it to reconcile an uncertain retry. Only settled work with actual files can submit; only an independent native review with current file hashes can mark the board complete. Unknown native starts/writes are not replayed. get never starts work; release waits for proved physical settlement.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'operationId', 'taskId', 'target'], properties: {
      action: { type: 'string', enum: ['execute', 'review', 'get', 'release'] }, operationId: { type: 'string' }, taskId: { type: 'string' },
      task: { type: 'string' }, submissionId: { type: 'string' }, target: { type: 'object', additionalProperties: false,
        required: ['baseToken', 'tableId', 'recordId'], properties: { baseToken: { type: 'string' }, tableId: { type: 'string' }, recordId: { type: 'string' } } },
    } }, outputSchema: { type: 'object' },
    execute: async (raw, context) => {
      context.signal.throwIfAborted(); await authorize(); const input = request(raw);
      const key = JSON.stringify([scope.source.projectRoot, scope.goal.id, input.target.baseToken, input.target.tableId, input.target.recordId, input.taskId]);
      const operation = JSON.stringify([key, input.operationId]);
      const port = options.boardPort?.(input.target) ?? createLarkTaskBoardPort(input.target, fields);
      const original = await port.read(), criteriaText = identify(original, input);
      const criteria = criteriaText.split('\n').map(value => value.trim()).filter(Boolean);
      if (!criteria.length || criteria.length > 100 || criteria.some(value => value.length > 4000)) { throw new Error('Task criteria exceed the supported record format'); }
      completionChecks.set(key, async () => {
        await scope.authorize(); const actual = await port.read(), record = await reviews.get(key);
        if (identify(actual, input) !== criteriaText || !record || !same(record.criteria, criteria) ||
            !same(actual.fields[field.status], ['完成']) || (await claims.get(key)).owner) {
          throw new Error('Goal has a board task without current settled completion');
        }
        await reviews.verifyApproved(key, record.revision);
      });
      const check = async (): Promise<void> => {
        context.signal.throwIfAborted(); await authorize();
        if (identify(await port.read(), input) !== criteriaText) { throw new Error('Task acceptance changed; inspect the actual record'); }
      };
      if (input.action === 'get' || input.action === 'release') {
        if (input.action === 'release') { await jobs.get(operation)?.settled; }
        const intent = await admissions.get(operation), nativeId = intent?.nativeId ?? jobs.get(operation)?.native?.id;
        const saved = nativeId ? await outbox.get(nativeId) : undefined;
        if (input.action === 'release') {
          if (!intent || (intent.phase !== 'prepared' && !saved)) { throw new Error('Cannot release an unknown native execution; inspect its actual result'); }
          await check(); await claims.release(intent.claim);
        }
        const record = await reviews.get(key);
        return { operationId: input.operationId, phase: intent?.phase ?? 'not-started', native: saved?.report,
          claim: await claims.get(key), review: record, approved: await approval(key, record) };
      }
      const kind = input.action;
      const fingerprint = createHash('sha256').update(JSON.stringify([key, scope.source.chatId, scope.source.actorId,
        kind, input.task ?? null, input.submissionId ?? null, criteria])).digest('hex');
      let job = jobs.get(operation);
      if (job && job.fingerprint !== fingerprint) { throw new Error('Goal board operation already belongs to different work'); }
      if (job?.flight) { return await job.flight; }
      job ??= { fingerprint }; jobs.set(operation, job); const entry = job;
      const work = (async (): Promise<Record<string, unknown>> => {
        await check();
        const existing = await admissions.get(operation);
        if (entry.native) { await admissions.confirmDispatch(operation, entry.native.id); }
        const intent = existing ?? await admissions.prepare(operation, fingerprint, key, (await claims.get(key)).revision);
        if (intent.fingerprint !== fingerprint) { throw new Error('Persisted Goal task operation belongs to different work'); }
        let record = await reviews.get(key);
        if (!record) {
          try { record = await reviews.create(key, criteria, intent.claim.owner); }
          catch (error) { record = await reviews.get(key); if (!record || !same(record.criteria, criteria)) { throw error; } }
        }
        if (!same(record.criteria, criteria)) { throw new Error('Task criteria changed; preserve existing submissions and reconcile before new work'); }
        const target = record.submissions.at(-1);
        const persisted = intent.nativeId ? await outbox.get(intent.nativeId) : undefined;
        const alreadySaved = intent.nativeId && record.submissions.some(value => value.id === intent.nativeId || value.review?.id === intent.nativeId);
        if (persisted && alreadySaved && (await claims.get(key)).owner !== intent.claim.owner) {
          return { operationId: input.operationId, native: persisted.report, review: record, approved: await approval(key, record) };
        }
        if (kind === 'review' && (!target || target.id !== input.submissionId)) { throw new Error('Review target is not the latest actual submission'); }
        let collector: TaskArtifactCollection | TaskReviewCollection;
        if (kind === 'execute') { collector = createTaskArtifactReport(criteria, check); }
        else { if (!target) { throw new Error('Review has no actual submission'); } collector = createTaskReviewReport(target, check); }
        const expectedRevision = record.revision;
        const project = new TaskBoardProjection(join(directory, 'board-intents'), {
          key: operation, recordId: input.target.recordId,
          required: { [field.task]: input.taskId, [field.goal]: scope.goal.id, [field.criteria]: criteriaText },
          writable: [field.owner, field.status, field.artifacts, field.review],
        }, port, check);
        let runner: AgentTaskRunner | undefined;
        const attempt = await prepareDurableClaimedTask({ admissions, claims, operationKey: operation, fingerprint, claimKey: key,
          expectedClaimRevision: intent.claim.revision - 1, ports: {
            authorize: check, ensureProjection: async claim => {
              // Recovery only reads the original native execution/result. Do
              // not rewind an already-submitted/reviewed board to running.
              if ((await admissions.get(operation))?.phase !== 'prepared') { return; }
              await project.ensure({ [field.owner]: `${claim.owner} @ r${claim.revision}`, [field.status]: ['执行中'] });
            },
            start: () => {
              const runtime = scope.runtimeOptions(); runner = new AgentTaskRunner({ ...runtime, configureQueryOptions: query => {
                const configured = runtime.configureQueryOptions?.(query) ?? query;
                return { ...configured, capacityAdmission: 'reject', onAsyncUserInputAnswer: undefined, tools: [...(configured.tools ?? []), collector.tool] };
              } }); runners.add(runner);
              const { source } = scope;
              const native = runner.start({ chatId: source.chatId, senderOpenId: source.actorId, sourceMessageId: source.sourceMessageId,
                workingDirectory: source.projectRoot, ...(source.chatType ? { chatType: source.chatType } : {}),
                ...(source.threadRootId ? { threadRootId: source.threadRootId } : {}),
                task: kind === 'execute' ? `${input.task}\n按 board_artifacts_report 的实际验收要求工作，读回产物并调用 report 提交实际文件引用。不要自称已通过独立review。`
                  : `独立review此任务，只读实际产物，不修改文件或启动其他agent。使用board_review_report get读取固定提交，逐项检查后report通过或驳回及具体依据。${input.task ?? ''}`,
              }, scope.callbacks); entry.native = native;
              entry.settled = (async () => {
                const result = await native.completion, proposal = collector.read();
                const metadata = { kind, expectedRevision, ...(kind === 'review' ? { submissionId: input.submissionId } : {}),
                  ...(result.outcome !== 'succeeded' || result.truncated ? { native: { error: result.error, text: result.text.slice(0, 2000), truncated: result.truncated } } : {}) };
                const proposed = JSON.stringify({ ...metadata, proposal });
                const summary = proposed.length <= 16000 ? proposed : JSON.stringify({ ...metadata, proposalOmitted: 'Proposal exceeds the durable receipt format; inspect actual output' });
                await outbox.publish({ id: result.id, chatId: source.chatId, actorId: source.actorId, sourceMessageId: source.sourceMessageId,
                  projectRoot: source.projectRoot, ...(source.threadRootId ? { threadRootId: source.threadRootId } : {}),
                  outcome: result.outcome, summary, artifacts: kind === 'execute' ? (proposal as { refs?: string[] } | undefined)?.refs ?? [] : [] });
                return result;
              })(); void entry.settled.catch(() => {});
              return { id: native.id, completion: entry.settled, stop: native.stop };
            },
            recover: async id => {
              if (entry.native?.id === id && entry.settled) { return { id, completion: entry.settled, stop: entry.native.stop }; }
              const saved = await outbox.get(id); if (!saved) { return undefined; }
              return { id, completion: Promise.resolve({ id, outcome: saved.report.outcome, text: saved.report.summary, truncated: false }), stop: () => {} };
            },
          } });
        try {
          const native = await attempt.start(context.signal);
          const stop = (): void => native.stop(); context.signal.addEventListener('abort', stop, { once: true });
          let result: AgentTaskResult;
          try { if (context.signal.aborted) { stop(); } result = await native.completion; }
          finally { context.signal.removeEventListener('abort', stop); }
          await check(); const saved = await outbox.get(result.id); if (!saved) { throw new Error('Actual native result is not durable'); }
          if (result.outcome !== 'succeeded' || result.truncated) { await attempt.release(); return { operationId: input.operationId, native: saved.report, submitted: false }; }
          const payload = JSON.parse(saved.report.summary) as SavedProposal;
          if (payload.kind !== kind || !Number.isSafeInteger(payload.expectedRevision) ||
              (kind === 'review' && payload.submissionId !== target?.id)) { throw new Error('Stored native proposal does not match this operation'); }
          if (!collector.read()) { await collector.tool.execute({ action: 'report', ...payload.proposal as object }, context); }
          const current = await reviews.get(key); if (!current) { throw new Error('Task review record disappeared'); } record = current;
          if (!record.submissions.some(value => value.id === result.id || value.review?.id === result.id)) {
            record = kind === 'execute' ? await finalizeTaskSubmission({ store: reviews, key, expectedRevision: payload.expectedRevision,
              collection: collector as TaskArtifactCollection, handle: native, authorize: check })
              : await finalizeTaskReview({ store: reviews, key, expectedRevision: payload.expectedRevision,
                collection: collector as TaskReviewCollection, handle: native, authorize: check });
          }
          const approved = kind === 'review' && record.submissions.at(-1)?.review?.verdict === 'approved';
          if (approved) { await reviews.verifyApproved(key, record.revision); }
          const latest = record.submissions.at(-1); if (!latest) { throw new Error('Task has no actual submission'); }
          await project.ensure({ [field.status]: [kind === 'execute' ? '待 review' : approved ? '完成' : '返工'],
            [field.artifacts]: JSON.stringify(latest.artifacts), [field.review]: latest.review ? JSON.stringify(latest.review) : '' });
          await attempt.release(); return { operationId: input.operationId, native: saved.report, review: record, approved };
        } catch (error) { await entry.settled?.catch(() => {}); throw error; }
        finally { collector.close(); if (runner) { await runner.close(); runners.delete(runner); } }
      })(); entry.flight = work;
      try { return await work; } catch (error) { if (entry.flight === work) { entry.flight = undefined; } throw error; }
    },
  };
  const close = (): Promise<void> => {
    closed = true; closing ??= (async () => {
      await Promise.allSettled([sync.close(), ...[...runners].map(runner => runner.close())]);
      await Promise.allSettled([...jobs.values()].flatMap(job => job.flight ? [job.flight] : []));
    })(); return closing;
  };
  return { tools: [...sync.tools, tool], stop: () => { void close().catch(() => {}); }, close,
    assess: async report => {
      if (report.outcome === 'completed') { for (const check of completionChecks.values()) { await check(); } }
    } };
}
