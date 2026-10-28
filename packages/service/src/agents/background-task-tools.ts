import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentInputContext, TaskCompletionReport, TaskResultOutbox, ToolContext, ToolDefinition } from '@disclaude/core';
import type { AgentTaskService } from './agent-task-service.js';
import { AGENT_TASK_TOOL_SPEC } from './agent-task-tool.js';
import type { BackgroundAgentTaskHandle, BackgroundAgentTasks } from './background-agent-tasks.js';

export interface BackgroundTaskToolsOptions {
  authorization: Pick<AgentTaskService, 'authorizeInput'>;
  tasks: BackgroundAgentTasks;
  outbox: TaskResultOutbox;
}
type Scope = Pick<TaskCompletionReport, 'chatId' | 'actorId' | 'projectRoot' | 'threadRootId'>;
const belongs = (a: Scope, b: Scope): boolean => a.chatId === b.chatId && a.actorId === b.actorId &&
  a.projectRoot === b.projectRoot && a.threadRootId === b.threadRootId;
const idInput = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' },
}, required: ['id'] };

/** Tool arguments carry work/IDs only. Origin and current policy use the same
 * host authorization port as synchronous tasks; no JSON source fallback.
 */
export class BackgroundTaskTools {
  private readonly active = new Map<string, { scope: Scope; handle: BackgroundAgentTaskHandle }>();
  constructor(private readonly options: BackgroundTaskToolsOptions) {}
  private capture(context: ToolContext, directory: string) {
    context.signal.throwIfAborted();
    if (!context.inputContext) { throw new Error('Background task input context is unavailable'); }
    const input: Readonly<AgentInputContext> = Object.freeze({ ...context.inputContext });
    const { facts, root } = this.options.authorization.authorizeInput(input, directory);
    const scope: Scope = { chatId: facts.chatId, actorId: facts.actorId, projectRoot: root,
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}) };
    return { input, facts, root, scope };
  }
  createTools(directory: string): ToolDefinition[] {
    return [{
      name: 'start_agent_task',
      description: 'Start a service-owned background subtask in this Project and return its admission ID promptly. The parent may finish this turn; its settled result will be reported later. Reuse this tool and operationId for an uncertain retry. Admission is not execution success; use get_agent_task for the saved result.',
      inputSchema: AGENT_TASK_TOOL_SPEC.inputSchema,
      outputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, state: { type: 'string', enum: ['accepted'] } }, required: ['id', 'state'] },
      execute: async (args, context) => {
        const { input, facts, root, scope } = this.capture(context, directory);
        if (typeof args.workingDirectory !== 'string' || isAbsolute(args.workingDirectory)) { throw new Error('Background task directory must be relative to its Project'); }
        const handle = await this.options.tasks.start(args.operationId as string, {
          task: args.task as string, workingDirectory: realpathSync(resolve(root, args.workingDirectory)), projectRoot: root,
          chatId: facts.chatId, senderOpenId: facts.actorId, sourceMessageId: facts.sourceMessageId,
          ...(facts.chatType ? { chatType: facts.chatType } : {}), ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
          ...(input.replyRootId !== undefined ? { replyRootId: input.replyRootId } : {}),
        }, context.signal);
        const entry = { scope, handle }; this.active.set(handle.id, entry);
        const release = (): void => { if (this.active.get(handle.id) === entry) { this.active.delete(handle.id); } };
        void handle.completion.then(release, release);
        return { id: handle.id, state: 'accepted' };
      },
    }, {
      name: 'get_agent_task', description: 'Inspect an admitted task in this user/chat/Project/topic. A saved result and parent notification state are separate; unknown results require reconciliation, not another execution.',
      inputSchema: idInput,
      outputSchema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' }, state: { type: 'string', enum: ['running', 'saved', 'unknown'] },
        outcome: { type: 'string', enum: ['succeeded', 'failed', 'stopped'] }, summary: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'string' } }, notification: { type: 'string', enum: ['pending', 'sending', 'delivered', 'uncertain'] },
      }, required: ['id', 'state'] },
      execute: async (args, context) => {
        const { input, scope } = this.capture(context, directory); const id = args.id as string;
        const record = await this.options.outbox.get(id);
        context.signal.throwIfAborted(); this.options.authorization.authorizeInput(input, directory);
        if (record && belongs(scope, record.report)) { return { id, state: 'saved', outcome: record.report.outcome,
          summary: record.report.summary, artifacts: record.report.artifacts, notification: record.delivery }; }
        const entry = this.active.get(id);
        return { id, state: entry && belongs(scope, entry.scope) ? 'running' : 'unknown' };
      },
    }, {
      name: 'stop_agent_task', description: 'Request cancellation of one owned background task. The request does not mean its work or delivery has settled; inspect get_agent_task afterwards.',
      inputSchema: idInput,
      outputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, stopRequested: { type: 'boolean' } }, required: ['id', 'stopRequested'] },
      execute: (args, context) => {
        const { scope } = this.capture(context, directory); const id = args.id as string, entry = this.active.get(id);
        const stopRequested = !!entry && belongs(scope, entry.scope);
        if (stopRequested) { entry.handle.stop(); }
        return Promise.resolve({ id, stopRequested });
      },
    }];
  }
}
