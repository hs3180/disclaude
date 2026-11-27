import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { TaskQuestion, TaskQuestionRecord } from '@disclaude/core';
import type { GoalExecutionService } from './goal-execution-service.js';

/** Body of `POST /api/task-questions` (#5591 G1): the ask half of a task
 * question. The identity fields are a *claim* — they only select among live
 * Goal bindings whose trusted source matches all of chat/actor/Project; they
 * authorize nothing by themselves. `goalId` may narrow an ambiguous trusted
 * set, never widen it. The answer half never travels through REST: it exists
 * only as the verified Feishu card callback. */
export interface TaskQuestionAskRequest {
  chatId: string;
  actorId: string;
  projectRoot: string;
  sourceMessageId: string;
  question: string;
  goalId?: string;
  threadRootId?: string;
  replyRootId?: string | null;
}

export interface TaskQuestionHostHandlers {
  ask(request: TaskQuestionAskRequest): Promise<TaskQuestionRecord>;
}

/** The only failure details the REST layer may reflect: constant host
 * messages about why a request was not admitted, never channel or SDK errors. */
export class TaskQuestionRequestError extends Error {
  constructor(
    readonly status: 409 | 503,
    readonly reason: 'rejected' | 'unavailable',
    message: string
  ) {
    super(message);
    this.name = 'TaskQuestionRequestError';
  }
}

export interface TaskQuestionRestOptions {
  goalExecution: Pick<GoalExecutionService, 'bindTaskQuestion'>;
  /** The running channel that owns the chat and can raise a task question card. */
  resolveChannel: (chatId: string) => { requestTaskQuestion(question: TaskQuestion): Promise<TaskQuestionRecord> } | undefined;
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const optionalText = (value: unknown): boolean => value === undefined || text(value, 512);

export function isTaskQuestionAskRequest(value: unknown): value is TaskQuestionAskRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const r = value as Record<string, unknown>;
  return ['chatId', 'actorId', 'sourceMessageId'].every(key => text(r[key], 512)) &&
    text(r.projectRoot, 4096) && isAbsolute(r.projectRoot) && text(r.question, 16000) &&
    (r.goalId === undefined || text(r.goalId, 512)) && optionalText(r.threadRootId) &&
    (r.replyRootId === undefined || r.replyRootId === null || text(r.replyRootId, 512));
}

/** Host side of the REST ask entry: bind the question to the live Goal turn
 * first, then hand only the bound question (taskKey = the Goal id chosen by the
 * trusted binding) to the channel. The question id is generated here, so a
 * caller can neither choose nor reuse another question's id. */
export function createTaskQuestionHostHandlers(options: TaskQuestionRestOptions): TaskQuestionHostHandlers {
  const { goalExecution, resolveChannel } = options;
  return {
    async ask(request) {
      const question: TaskQuestion = {
        id: randomUUID(),
        // A placeholder until the trusted binding replaces it with the Goal id.
        taskKey: request.goalId ?? 'pending-bind',
        question: request.question,
        chatId: request.chatId,
        actorId: request.actorId,
        sourceMessageId: request.sourceMessageId,
        projectRoot: request.projectRoot,
        ...(request.threadRootId !== undefined ? { threadRootId: request.threadRootId } : {}),
        ...(request.replyRootId !== undefined ? { replyRootId: request.replyRootId } : {}),
      };
      let bound: Readonly<TaskQuestion>;
      try {
        bound = await goalExecution.bindTaskQuestion(question, request.goalId);
      } catch {
        // One constant sentence for every bind refusal (no live binding,
        // Goal paused/stopped/changed, policy denied): the host messages may
        // carry store paths, so the REST layer never reflects them.
        throw new TaskQuestionRequestError(409, 'rejected', 'No live Goal turn of this user and Project admits this task question');
      }
      const channel = resolveChannel(request.chatId);
      if (!channel) {
        throw new TaskQuestionRequestError(503, 'unavailable', 'Task questions require the running Feishu channel of this chat');
      }
      return channel.requestTaskQuestion(bound);
    },
  };
}
