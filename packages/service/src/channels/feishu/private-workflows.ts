import { randomUUID } from 'node:crypto';
import {
  ActionBoundInput,
  createPrivateProcessAction,
  createLogger,
  type PrivateProcessActionOptions,
} from '@disclaude/core';
import { FeishuPrivateInput } from './private-input.js';

export interface PrivateWorkflowRequest {
  chatId: string;
  actorId: string;
  sourceMessageId: string;
  workflow: Omit<PrivateProcessActionOptions, 'id'>;
}

/** Validate transport shape only. Workflow policy belongs to the authenticated agent. */
export function isPrivateWorkflowRequest(value: unknown): value is PrivateWorkflowRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  const w = r.workflow as Record<string, unknown> | undefined;
  return (
    ['chatId', 'actorId', 'sourceMessageId'].every(
      (k) => typeof r[k] === 'string' && (r[k] as string).length > 0
    ) &&
    !!w &&
    typeof w === 'object' &&
    !Array.isArray(w) &&
    ['command', 'title', 'description'].every(
      (k) => typeof w[k] === 'string' && (w[k] as string).length > 0
    ) &&
    (w.args === undefined ||
      (Array.isArray(w.args) && w.args.every((a) => typeof a === 'string'))) &&
    (w.cwd === undefined || typeof w.cwd === 'string') &&
    (w.env === undefined ||
      (!!w.env &&
        typeof w.env === 'object' &&
        !Array.isArray(w.env) &&
        Object.values(w.env).every((v) => typeof v === 'string'))) &&
    (w.timeoutMs === undefined ||
      (typeof w.timeoutMs === 'number' && Number.isFinite(w.timeoutMs) && w.timeoutMs > 0))
  );
}

/** Each request freezes a task-selected consumer; form callbacks cannot replace it. */
export class FeishuPrivateWorkflows {
  private readonly pending = new Map<
    string,
    { input: FeishuPrivateInput; actor: string; chat: string; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(private readonly send: ConstructorParameters<typeof FeishuPrivateInput>[1]) {}

  async request(request: PrivateWorkflowRequest): Promise<{ actionId: string }> {
    if (!isPrivateWorkflowRequest(request)) {
      throw new Error('Invalid private workflow');
    }
    for (const [id, entry] of this.pending) {
      if (entry.actor === request.actorId && entry.chat === request.chatId) {
        this.remove(id);
      }
    }
    if (this.pending.size >= 500) {
      throw new Error('Too many pending private workflows');
    }
    const actionId = randomUUID();
    const audit = createLogger('PrivateWorkflow');
    const input = new FeishuPrivateInput(
      new ActionBoundInput(
        createPrivateProcessAction({ ...request.workflow, id: actionId }),
        (event) => audit.info(event, 'Private workflow completed')
      ),
      this.send
    );
    const timer = setTimeout(() => this.remove(actionId), 300_000);
    timer.unref();
    this.pending.set(actionId, { input, actor: request.actorId, chat: request.chatId, timer });
    try {
      await input.request(actionId, request.actorId, request.chatId, request.sourceMessageId);
    } catch {
      this.remove(actionId);
      throw new Error('Private workflow card was not delivered');
    }
    return { actionId };
  }

  async submit(data: Record<string, unknown>): Promise<boolean> {
    const action = data.action as { value?: { private_action?: unknown } } | undefined;
    const id = action?.value?.private_action;
    if (typeof id !== 'string') {
      return false;
    }
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    const outcome = await entry.input.submit(data);
    if (outcome && outcome !== 'invalid') {
      this.remove(id);
    }
    return true;
  }

  private remove(id: string): void {
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      entry.input.revoke();
      this.pending.delete(id);
    }
  }
  revoke(): void {
    for (const id of this.pending.keys()) {
      this.remove(id);
    }
  }
}
