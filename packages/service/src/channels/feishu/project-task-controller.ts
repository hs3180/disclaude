import type { TaskOperation, TaskActorContext } from '../../harness/project-task-gateway.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ProjectStore } from '../../harness/project-task.js';
import { ProjectTaskManager, type TaskRunner, type ProjectAction } from '../../harness/project-task-manager.js';
import { createProjectTaskRunner } from '../../harness/project-task-runner.js';
import { indexCard, projectCard, evidenceCard, historyCard, projectLinkPreviewCard } from './project-task-cards.js';
import type { DocumentReader, DocumentAppender } from '../../harness/document-source.js';

type Sender = (message: { chatId: string; type: string; text?: string; card?: Record<string, unknown>; threadId?: string }) => Promise<string | void>;
type Updater = (messageId: string, card: Record<string, unknown>) => Promise<void>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const page = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function callbackValue(action: Record<string, unknown>): Record<string, unknown> {
  if (object(action.value).research === true) { return object(action.value); }
  const name = string(action.name);
  if (name.startsWith('research:') && name.length <= 500) {
    try { return { ...object(JSON.parse(name.slice(9))), research: true }; } catch { /* Invalid form identity. */ }
  }
  return {};
}

/** A persistent project surface; ordinary conversation turns never own its state. */
export class FeishuProjectTaskController {
  readonly manager: ProjectTaskManager;
  constructor(directory: string, workspace: string, private readonly send: Sender, update: Updater, runner: TaskRunner = createProjectTaskRunner(workspace), readDocument?: DocumentReader, appendDocument?: DocumentAppender, private readonly resolveWorkingDir?: (chat: string) => Promise<string>) {
    if (!isAbsolute(directory)) { throw new Error('Research project storage must use an absolute directory'); }
    this.manager = new ProjectTaskManager(new ProjectStore(directory), runner, async project => {
      const card = projectCard(project);
      if (project.cardId) { await update(project.cardId, card); return project.cardId; }
      const id = await send({ chatId: project.chat, type: 'card', card, threadId: project.thread });
      if (!id) { throw new Error('Research project card delivery returned no message ID'); }
      return id;
    }, readDocument, appendDocument);
  }
  /** Actor identity comes only from the receiving channel, never operation JSON. */
  async executeTask(context: TaskActorContext, operation: TaskOperation): Promise<unknown> {
    const { owner, chat, source, thread } = context;
    if (!owner || !chat || !source) { throw new Error('Task actor context unavailable'); }
    if (operation.action === 'list') {
      const all = this.manager.list(owner, chat, operation.archived ?? false);
      const offset = operation.offset ?? 0, end = offset + (operation.limit ?? 20);
      return { tasks: all.slice(offset, end).map(p => ({ id: p.id, title: p.title, status: p.status, revision: p.revision, workingDir: p.workingDir })),
        total: all.length, nextOffset: end < all.length ? end : undefined };
    }
    if (operation.action === 'create') {
      const creationSource = `${source}:agent:${operation.requestId}`;
      const existing = [...this.manager.list(owner, chat), ...this.manager.list(owner, chat, true)].find(p => p.source === creationSource);
      if (existing) { return { task: existing }; }
      if (!this.resolveWorkingDir) { throw new Error('Project directory resolver unavailable'); }
      const task = await this.manager.create({ owner, chat, source: creationSource, thread,
        workingDir: await this.resolveWorkingDir(chat), title: operation.title, scope: operation.scope ?? '',
        materials: operation.materials ?? '', documentUrl: operation.documentUrl });
      return { task };
    }
    // get/act both preserve the original creator and chat boundary.
    if (operation.action === 'control') {
      const current = this.manager.get(operation.taskId, owner, chat);
      if (current.revision !== operation.revision) { throw new Error('Task revision changed; read current state before retrying'); }
      await this.manager.act(operation.taskId, owner, chat, operation.revision, operation.control, operation.value ?? '');
    }
    return { task: this.manager.get(operation.taskId, owner, chat) };
  }
  static isCallback(raw: Record<string, unknown>): boolean {
    return callbackValue(object(raw.action)).research === true;
  }
  async open(owner: string, chat: string, thread?: string): Promise<void> {
    if (!owner || !chat) { throw new Error('无法确认任务的用户和会话。'); }
    await this.showIndex(owner, chat, thread);
  }
  private async showIndex(owner: string, chat: string, thread?: string, offset = 0, archived = false): Promise<void> {
    let workingDir: string | undefined, error: string | undefined;
    try { workingDir = await this.resolveWorkingDir?.(chat); }
    catch { error = '当前项目目录不可用，暂不能建立新任务。请用 /project info 检查，或用 /project use <目录> 切换。已有任务仍可打开。'; }
    await this.send({ chatId: chat, type: 'card', threadId: thread,
      card: indexCard(this.manager.list(owner, chat, archived), randomUUID(), offset, archived, { workingDir, error }) });
  }
  async handle(raw: Record<string, unknown>): Promise<void> {
    const context = object(raw.context), operator = object(raw.operator), action = object(raw.action);
    const owner = string(operator.open_id), chat = string(context.open_chat_id), message = string(context.open_message_id);
    if (!owner || !chat || !message) { return; }
    try {
      const value = callbackValue(action), form = object(action.form_value);
      const actionName = string(value.action), id = string(value.project);
      if (actionName === 'index') {
        await this.showIndex(owner, chat, message, page(value.offset), value.archived === true);
        return;
      }
      if (actionName === 'create') {
        const nonce = string(value.nonce);
        if (!nonce || nonce.length > 100) { throw new Error('创建表单已失效，请重新打开任务。'); }
        const source = `${message}:${nonce}`;
        const existing = [...this.manager.list(owner, chat), ...this.manager.list(owner, chat, true)].find(p => p.source === source);
        // A retry must reopen its original research even if the chat binding changed or disappeared.
        if (existing) { await this.manager.show(existing.id, owner, chat); return; }
        await this.manager.create({ workingDir: await this.resolveWorkingDir?.(chat), owner, chat, thread: message, source, title: string(form.question), scope: string(form.scope), materials: string(form.materials), documentUrl: string(form.document_url) });
        return;
      }
      const project = this.manager.get(id, owner, chat);
      if (actionName === 'preview-project-link' || actionName === 'confirm-project-link') {
        if (!this.resolveWorkingDir || typeof value.revision !== 'number') { throw new Error('当前项目目录不可用，请检查目录绑定。'); }
        const directory = await this.resolveWorkingDir(chat);
        if (actionName === 'preview-project-link') {
          const preview = await this.manager.previewProjectLink(id, owner, chat, value.revision, directory);
          await this.send({ chatId: chat, type: 'card', threadId: project.thread, card: projectLinkPreviewCard(preview) });
        } else { await this.manager.confirmProjectLink(id, owner, chat, value.revision, string(value.token), directory); }
        return;
      }
      if (actionName === 'unlink-project' && typeof value.revision === 'number') {
        await this.manager.unlinkProject(id, owner, chat, value.revision); return;
      }
      if (['open', 'refresh'].includes(actionName)) { await this.manager.show(id, owner, chat, actionName === 'open' ? { thread: message } : undefined); return; }
      if (actionName === 'evidence') {
        await this.send({ chatId: chat, type: 'card', threadId: project.thread, card: evidenceCard(project, string(value.direction), page(value.index)) }); return;
      }
      if (actionName === 'history') {
        await this.send({ chatId: chat, type: 'card', threadId: project.thread, card: historyCard(project, page(value.offset)) }); return;
      }
      if (actionName === 'continue' || actionName === 'continue-finding') {
        if (!['completed', 'cancelled'].includes(project.status)) { throw new Error('请先结束当前任务，再从成果建立后续任务。'); }
        // Retrying the same result-card action returns the existing successor.
        const parentFinding = actionName === 'continue-finding' ? { directionId: string(value.direction), index: typeof value.index === 'number' ? value.index : -1 } : undefined;
        const source = parentFinding ? `${message}:continue:${id}:${JSON.stringify(parentFinding)}` : `${message}:continue:${id}`;
        await this.manager.create({ owner, chat, thread: project.thread, source, parent: id, parentFinding,
          title: project.title, scope: project.scope, materials: project.materials, documentUrl: project.document?.url });
        return;
      }
      const actions: ProjectAction[] = ['pause', 'resume', 'cancel', 'feedback', 'stop-direction', 'archive', 'unarchive', 'export'];
      if (!actions.includes(actionName as ProjectAction) || typeof value.revision !== 'number') { throw new Error('任务操作无效，请刷新任务。'); }
      await this.manager.act(id, owner, chat, value.revision, actionName as ProjectAction,
        actionName === 'feedback' ? string(form.feedback) : string(value.direction));
    } catch (error) {
      await this.send({ chatId: chat, type: 'text', text: error instanceof Error && /^[\p{Script=Han}]/u.test(error.message) ? error.message : '任务操作未完成，已有任务保留。请稍后重试。' });
    }
  }
  dispose(): void { this.manager.dispose(); }
}
