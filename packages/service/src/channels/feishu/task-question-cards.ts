import type { Client } from '@larksuiteoapi/node-sdk';
import type { TaskQuestion, TaskQuestionRecord } from '@disclaude/core';
import { TaskQuestionFlow, type TaskQuestionFlowPorts } from '../../agents/task-question-flow.js';

const prefix = 'task-question:';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (content: string) => ({ tag: 'plain_text', content });
const replyRoot = (q: TaskQuestion): string | null => q.replyRootId !== undefined ? q.replyRootId : q.threadRootId ?? q.sourceMessageId;
function card(q: TaskQuestion, state?: TaskQuestionRecord): Record<string, unknown> {
  const answered = !!state?.answer, cancelled = !!state?.cancelled;
  const label = cancelled ? '原任务已取消，不能继续提交' : answered
    ? state?.wake === 'delivered' ? '回答已保存并送回原任务；不代表任务已完成' : '回答已保存；原任务恢复或入队状态待核对'
    : '请补充这项任务需要的非私密信息；其他任务可以继续';
  const elements: Record<string, unknown>[] = [{ tag: 'div', text: text(label) }, { tag: 'div', text: text(q.question) }];
  if (!answered && !cancelled) {
    elements.push({ tag: 'form', name: `question-form-${q.id}`, elements: [
      { tag: 'input', name: `${prefix}${q.id}:answer`, input_type: 'multiline_text', required: true, placeholder: text('填写非私密业务反馈；凭据请使用私密输入入口') },
      { tag: 'button', name: `${prefix}${q.id}:submit`, type: 'primary_filled', text: text('提交回答'), form_action_type: 'submit' },
    ] });
  }
  return { schema: '2.0', config: { enable_forward: false, update_multi: true },
    header: { title: text('任务等待反馈'), template: answered ? 'green' : 'blue' }, body: { elements } };
}
function hasButton(value: unknown, name: string, depth = 0): boolean {
  if (depth > 64) { return false; }
  if (Array.isArray(value)) { return value.some(item => hasButton(item, name, depth + 1)); }
  const node = object(value);
  return node.tag === 'button' && node.name === name || Object.values(node).some(item => typeof item === 'object' && item !== null && hasButton(item, name, depth + 1));
}

/** Attach only to authenticated Feishu card.action.trigger dispatch. Persisted
 * source strings alone are not authorization; host ports check current policy.
 * No provider turn signal expires these task-specific questions.
 */
export class FeishuTaskQuestionCards {
  private readonly flow: TaskQuestionFlow;
  private closing = false;
  private readonly callbacks = new Set<Promise<void>>();
  private readonly updates = new Map<string, Promise<void>>();
  constructor(private readonly client: Client, private readonly appId: string,
    private readonly host: Omit<TaskQuestionFlowPorts, 'send' | 'reconcileCard'>) {
    this.flow = new TaskQuestionFlow({ ...host, send: q => this.send(q), reconcileCard: (q, id) => this.reconcile(q, id) });
  }
  static isCallback(data: Record<string, unknown>): boolean { const { name } = object(data.action); return typeof name === 'string' && name.startsWith(prefix); }
  ask(question: TaskQuestion): Promise<TaskQuestionRecord> {
    if (this.closing) { return Promise.reject(new Error('Task question cards are closing')); }
    return this.flow.ask(question);
  }
  reconcileWake(id: string): Promise<TaskQuestionRecord> {
    if (this.closing) { return Promise.reject(new Error('Task question cards are closing')); }
    return this.flow.reconcileWake(id);
  }
  handleAuthenticatedCallback(data: Record<string, unknown>): { toast: { type: 'info'; content: string } } {
    const action = object(data.action);
    if (action.tag === 'input') { return { toast: { type: 'info', content: '输入已同步；点击提交后才算回答。' } }; }
    if (!this.closing) {
      const work = this.submit(data).catch(() => {}); this.callbacks.add(work);
      void work.then(() => { this.callbacks.delete(work); });
    }
    return { toast: { type: 'info', content: this.closing ? '任务交互正在关闭；已保存的回答会保留。' : '已收到操作，正在核对原任务。' } };
  }
  async close(): Promise<void> { this.closing = true; await Promise.all([...this.callbacks]); await this.flow.close(); await Promise.allSettled([...this.updates.values()]); }
  private receipt(q: TaskQuestion, messageId: string, chatId: string) {
    return { messageId, chatId, ...(q.threadRootId !== undefined ? { threadRootId: q.threadRootId } : {}),
      ...(q.replyRootId !== undefined ? { replyRootId: q.replyRootId } : {}) };
  }
  private async send(q: Readonly<TaskQuestion>) {
    const parent = replyRoot(q), content = JSON.stringify(card(q));
    const result = parent === null
      ? await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: q.chatId, msg_type: 'interactive', content, uuid: q.id } })
      : await this.client.im.message.reply({ path: { message_id: parent }, data: { msg_type: 'interactive', content, reply_in_thread: true, uuid: q.id } });
    if (result.code !== 0 || !result.data?.message_id || result.data.chat_id !== q.chatId) { throw new Error('Task question card delivery was not confirmed'); }
    return this.receipt(q, result.data.message_id, result.data.chat_id);
  }
  private async reconcile(q: Readonly<TaskQuestion>, messageId: string) {
    const response = await this.client.im.message.get({ path: { message_id: messageId } });
    const item = response.data?.items?.find(value => value.message_id === messageId), parent = replyRoot(q);
    const correctRoute = item && (parent === null ? !item.parent_id && (!item.root_id || item.root_id === messageId)
      : (item.parent_id === parent || item.root_id === parent) && (!q.threadRootId || item.root_id === q.threadRootId || item.parent_id === q.threadRootId));
    if (response.code !== 0 || !item || item.deleted || item.chat_id !== q.chatId || item.msg_type !== 'interactive' ||
      item.sender?.sender_type !== 'app' || item.sender.id_type !== 'app_id' || item.sender.id !== this.appId || !correctRoute ||
      !item.body?.content || Buffer.byteLength(item.body.content) > 128 * 1024) { throw new Error('Cannot verify original task question card'); }
    let body: unknown; try { body = JSON.parse(item.body.content); } catch { throw new Error('Cannot read original task question card'); }
    if (!hasButton(body, `${prefix}${q.id}:submit`)) { throw new Error('Card does not contain this task question'); }
    return this.receipt(q, messageId, item.chat_id);
  }
  private async submit(data: Record<string, unknown>): Promise<void> {
    const action = object(data.action), name = typeof action.name === 'string' ? action.name : '';
    const match = /^task-question:([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}):submit$/.exec(name);
    if (!match || action.tag !== 'button') { return; }
    const [, id] = match;
    const context = object(data.context), actorId = object(data.operator).open_id;
    const q = await this.host.store.get(id); if (!q || actorId !== q.question.actorId || context.open_chat_id !== q.question.chatId) { return; }
    if (q.cancelled) { if (context.open_message_id === q.cardMessageId) { await this.paint(q).catch(() => {}); } return; }
    const messageId = context.open_message_id, answer = object(action.form_value)[`${prefix}${id}:answer`];
    if (typeof actorId !== 'string' || typeof messageId !== 'string' || typeof answer !== 'string' || !answer.trim() || answer.length > 16000) { return; }
    let saved: TaskQuestionRecord;
    try {
      saved = await this.flow.acceptAuthenticatedAnswer(id, { actorId, chatId: q.question.chatId, messageId, text: answer,
        ...(typeof data.event_id === 'string' ? { eventId: data.event_id } : {}) });
    } catch { return; }
    await this.paint(saved).catch(() => {});
    if (!this.closing) { await this.flow.wake(id).catch(() => {}); }
    const current = await this.host.store.get(id); if (current) { await this.paint(current).catch(() => {}); }
  }
  private async paint(record: TaskQuestionRecord): Promise<void> {
    if (!record.cardMessageId) { return; }
    const id = record.cardMessageId;
    const work = (this.updates.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const latest = await this.host.store.get(record.question.id); if (!latest) { return; }
      const response = await this.client.im.message.patch({ path: { message_id: id }, data: { content: JSON.stringify(card(latest.question, latest)) } });
      if (response.code !== 0) { throw new Error('Task question card repaint was not confirmed'); }
    });
    this.updates.set(id, work);
    try { await work; } finally { if (this.updates.get(id) === work) { this.updates.delete(id); } }
  }
}
