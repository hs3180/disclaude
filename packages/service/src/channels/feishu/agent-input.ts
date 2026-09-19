import { randomUUID } from 'node:crypto';
import type { Client } from '@larksuiteoapi/node-sdk';
import { validateAgentInputAnswers, type AgentInputRequest, type AgentInputContext, type AgentInputAnswers } from '@disclaude/core';

type Pending = { request: AgentInputRequest; context: AgentInputContext; card?: string; chat?: string;
  state: 'waiting' | 'submitting' | 'answered' | 'expired' | 'failed'; error?: string; updates?: Promise<void> };
const plain = (content: string) => ({ tag: 'plain_text', content });
const text = (content: string) => ({ tag: 'div', text: plain(content) });
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Answers stay in the callback/RPC path, outside chat history and action prompts. */
export class FeishuAgentInput {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly client: Client) {}

  static isCallback(data: Record<string, unknown>): boolean {
    const { name } = object(data.action);
    return typeof name === 'string' && name.startsWith('agent-input:');
  }

  private card(token: string, pending: Pending): Record<string, unknown> {
    const { request, state } = pending;
    const inactive: Record<string, string> = { expired: '回答已过期，未自动选择答案', cancelled: '已取消', resolved: '问题已结束，无需回答',
      'turn-ended': '任务已结束，不能再提交', closed: '连接已断开，表单失效', unavailable: '输入请求不可用' };
    const expiry = typeof request.signal.reason === 'string' ? inactive[request.signal.reason] : undefined;
    const label = { waiting: request.isBlocking ? '等待你的回答' : '可补充回答，任务仍在继续', submitting: '正在提交', answered: '已回答', expired: expiry ?? '请求已结束或过期', failed: '提交未完成，请重新发起任务' }[state];
    const elements: Record<string, unknown>[] = [text(label)];
    if (pending.error) { elements.push(text(pending.error)); }
    if (state === 'waiting') {
      const fields = request.questions.flatMap((q, index): Record<string, unknown>[] => [
        text(`${q.header ? `${q.header}\n` : ''}${q.question}`),
        ...(q.options?.length ? [text(q.options.map(o => `${o.label}${o.description ? `：${o.description}` : ''}`).join('\n')),
          { tag: 'select_static', name: `choice_${index}`, required: !q.isOther, placeholder: plain('请选择'),
            options: q.options.map((o, i) => ({ text: plain(o.label), value: String(i) })) }] : []),
        ...(!q.options?.length || q.isOther ? [{ tag: 'input', name: `text_${index}`, required: !q.options?.length,
          input_type: q.isSecret ? 'password' : 'multiline_text', placeholder: plain(q.isOther && q.options?.length ? '或填写其他答案（以填写内容为准）' : '填写答案') }] : []),
      ]);
      elements.push(text(request.questions.some(q => q.isSecret) ? '本表单仅在私聊中显示；回答不会回显。请明确点击提交。' : '选择或填写后点击提交；未提交的选择不算回答。'),
        { tag: 'form', name: 'agent_questions', elements: [...fields,
          { tag: 'button', name: `agent-input:${token}`, type: 'primary_filled', text: plain('提交回答'), form_action_type: 'submit' }] });
    }
    return { schema: '2.0', config: { enable_forward: false, update_multi: true },
      header: { title: plain('任务需要你的输入'), template: state === 'answered' ? 'green' : 'blue' }, body: { elements } };
  }

  private async update(token: string, p: Pending): Promise<void> {
    if (!p.card) { return; }
    const messageId = p.card;
    p.updates = (p.updates ?? Promise.resolve()).catch(() => {}).then(async () => {
      const result = await this.client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(this.card(token, p)) } });
      if (result.code !== 0) { throw new Error('Input card update failed'); }
    });
    await p.updates;
  }

  async request(request: AgentInputRequest, context: AgentInputContext): Promise<void> {
    if (!context.actorId || !context.chatId || !context.sourceMessageId || request.signal.aborted) { throw new Error('Input request has no authorized actor'); }
    if (this.pending.size >= 256) {
      for (const [token, p] of this.pending) { if (p.state !== 'waiting' && p.state !== 'submitting') { this.pending.delete(token); } }
      if (this.pending.size >= 256) { throw new Error('Too many pending input requests'); }
    }
    const token = randomUUID();
    const p: Pending = { request, context, state: 'waiting' };
    this.pending.set(token, p);
    request.signal.addEventListener('abort', () => {
      if (p.state === 'answered' || p.state === 'failed') { return; }
      p.state = 'expired';
      void this.update(token, p).catch(() => {});
    }, { once: true });
    try {
      const secret = request.questions.some(q => q.isSecret);
      const content = JSON.stringify(this.card(token, p));
      const result = secret
        ? await this.client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: context.actorId, msg_type: 'interactive', content } })
        : await this.client.im.message.reply({ path: { message_id: context.threadRootId ?? context.sourceMessageId }, data: { msg_type: 'interactive', content, reply_in_thread: true } });
      if (result.code !== 0 || !result.data?.message_id || !result.data.chat_id) { throw new Error('Input card was not delivered'); }
      p.card = result.data.message_id;
      p.chat = result.data.chat_id;
      if (!secret && p.chat !== context.chatId) { p.state = 'failed'; await this.update(token, p); throw new Error('Input card chat mismatch'); }
      if (request.signal.aborted) { p.state = 'expired'; await this.update(token, p); }
      // Secret questions and values are never included in a public notice.
      if (secret && !request.signal.aborted) {
        await this.client.im.message.reply({ path: { message_id: context.sourceMessageId },
          data: { msg_type: 'text', content: JSON.stringify({ text: '任务需要私密输入，请在与机器人的私聊中填写并提交。' }), reply_in_thread: true } }).catch(() => {});
      }
    } catch { p.state = 'failed'; await this.update(token, p).catch(() => {}); throw new Error('Input card could not be delivered'); }
  }

  async submit(data: Record<string, unknown>): Promise<void> {
    const action = object(data.action);
    const { name } = action;
    if (typeof name !== 'string') { return; }
    const token = name.slice('agent-input:'.length);
    const p = this.pending.get(token);
    const context = object(data.context);
    if (!p || object(data.operator).open_id !== p.context.actorId || context.open_chat_id !== p.chat || context.open_message_id !== p.card) { return; }
    if (p.state !== 'waiting' || p.request.signal.aborted) { await this.update(token, p).catch(() => {}); return; }
    const form = object(action.form_value);
    let answers: AgentInputAnswers;
    try {
      const values: AgentInputAnswers = Object.create(null) as AgentInputAnswers;
      for (const [index, q] of p.request.questions.entries()) {
        const free = form[`text_${index}`];
        const selected = form[`choice_${index}`];
        const choice = typeof selected === 'string' && /^(0|[1-9]\d*)$/u.test(selected) ? q.options?.[Number(selected)]?.label : undefined;
        const value = (!q.options?.length || q.isOther) && typeof free === 'string' && free.trim() ? free : choice;
        values[q.id] = { answers: value ? [value] : [] };
      }
      answers = validateAgentInputAnswers(p.request, values);
    } catch { p.error = '请回答每个问题后提交。'; await this.update(token, p).catch(() => {}); return; }
    p.state = 'submitting'; p.error = undefined;
    // A slow repaint must not delay a timely answer past the input deadline.
    // Updates remain serialized; duplicate callbacks already see submitting.
    void this.update(token, p).catch(() => {});
    try { await p.request.respond(answers); p.state = 'answered'; }
    catch { p.state = p.request.signal.aborted ? 'expired' : 'failed'; }
    await this.update(token, p).catch(() => {});
  }

  close(): void {
    for (const [token, p] of this.pending) {
      if (p.state === 'waiting' || p.state === 'submitting') { p.state = 'expired'; void this.update(token, p).catch(() => {}); }
    }
    this.pending.clear();
  }
}
