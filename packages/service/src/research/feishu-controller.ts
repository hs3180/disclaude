import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ProjectStore } from './project.js';
import { ResearchManager, type StepRunner, type ProjectAction } from './manager.js';
import { createResearchRunner } from './runner.js';
import { indexCard, projectCard, evidenceCard, historyCard } from './cards.js';

type Sender = (message: { chatId: string; type: string; text?: string; card?: Record<string, unknown>; threadId?: string }) => Promise<string | void>;
type Updater = (messageId: string, card: Record<string, unknown>) => Promise<void>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const page = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** A persistent project surface; ordinary conversation turns never own its state. */
export class FeishuResearchController {
  readonly manager: ResearchManager;
  constructor(directory: string, workspace: string, private readonly send: Sender, update: Updater, runner: StepRunner = createResearchRunner(workspace)) {
    if (!isAbsolute(directory)) { throw new Error('Research project storage must use an absolute directory'); }
    this.manager = new ResearchManager(new ProjectStore(directory), runner, async project => {
      const card = projectCard(project);
      if (project.cardId) { await update(project.cardId, card); return project.cardId; }
      const id = await send({ chatId: project.chat, type: 'card', card, threadId: project.thread });
      if (!id) { throw new Error('Research project card delivery returned no message ID'); }
      return id;
    });
  }
  static isCallback(raw: Record<string, unknown>): boolean {
    return object(object(raw.action).value).research === true;
  }
  async open(owner: string, chat: string, thread?: string): Promise<void> {
    if (!owner || !chat) { throw new Error('无法确认研究项目的用户和会话。'); }
    await this.send({ chatId: chat, type: 'card', threadId: thread, card: indexCard(this.manager.list(owner, chat), randomUUID()) });
  }
  async handle(raw: Record<string, unknown>): Promise<void> {
    const context = object(raw.context), operator = object(raw.operator), action = object(raw.action);
    const owner = string(operator.open_id), chat = string(context.open_chat_id), message = string(context.open_message_id);
    if (!owner || !chat || !message) { return; }
    try {
      const value = object(action.value), form = object(action.form_value);
      const actionName = string(value.action), id = string(value.project);
      if (actionName === 'index') {
        await this.send({ chatId: chat, type: 'card', threadId: message, card: indexCard(this.manager.list(owner, chat), randomUUID(), page(value.offset)) });
        return;
      }
      if (actionName === 'create') {
        const nonce = string(value.nonce);
        if (!nonce || nonce.length > 100) { throw new Error('创建表单已失效，请重新打开研究项目。'); }
        await this.manager.create({ owner, chat, thread: message, source: `${message}:${nonce}`, title: string(form.question), scope: string(form.scope), materials: string(form.materials) });
        return;
      }
      const project = this.manager.get(id, owner, chat);
      if (['open', 'refresh'].includes(actionName)) { await this.manager.show(id, owner, chat, actionName === 'open' ? { thread: message } : undefined); return; }
      if (actionName === 'evidence') {
        await this.send({ chatId: chat, type: 'card', threadId: project.thread, card: evidenceCard(project, string(value.direction), page(value.index)) }); return;
      }
      if (actionName === 'history') {
        await this.send({ chatId: chat, type: 'card', threadId: project.thread, card: historyCard(project, page(value.offset)) }); return;
      }
      if (actionName === 'continue') {
        if (!['completed', 'cancelled'].includes(project.status)) { throw new Error('请先结束当前研究，再从成果建立后续项目。'); }
        // Retrying the same result-card action returns the existing successor.
        await this.manager.create({ owner, chat, thread: project.thread, source: `${message}:continue:${id}`, parent: id,
          title: project.title, scope: project.scope, materials: project.materials });
        return;
      }
      const actions: ProjectAction[] = ['pause', 'resume', 'cancel', 'feedback', 'stop-direction'];
      if (!actions.includes(actionName as ProjectAction) || typeof value.revision !== 'number') { throw new Error('研究操作无效，请刷新项目。'); }
      await this.manager.act(id, owner, chat, value.revision, actionName as ProjectAction,
        actionName === 'feedback' ? string(form.feedback) : string(value.direction));
    } catch (error) {
      await this.send({ chatId: chat, type: 'text', text: error instanceof Error && /^[\p{Script=Han}]/u.test(error.message) ? error.message : '研究操作未完成，已有项目保留。请稍后重试。' });
    }
  }
  dispose(): void { this.manager.dispose(); }
}
