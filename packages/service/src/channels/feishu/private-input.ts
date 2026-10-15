import type { ActionBoundInput } from '@disclaude/core';

type Send = (message: { chatId: string; type: string; text?: string; card?: Record<string, unknown> }) => Promise<string | void>;
export type UpdatePrivateCard = (cardId: string, card: Record<string, unknown>) => Promise<void>;
export const PRIVATE_INPUT_EXPIRED = '表单无效、已过期或已使用（服务重启后亦失效），请重新发起。';

function statusCard(text: string): Record<string, unknown> {
  return { schema: '2.0', config: { enable_forward: false, update_multi: true },
    header: { title: { tag: 'plain_text', content: '私密输入已结束' } },
    body: { elements: [{ tag: 'markdown', content: text }] } };
}

/** Transport only: action selection/policy and credential consumption belong
 * to the installed agent operation. Feishu does not know the auth provider,
 * target service or permission rules. Callback values bypass ordinary message
 * logging, agent prompts and conversation history.
 */
export class FeishuPrivateInput {
  private readonly cards = new Map<string, { actor: string; chat: string }>();
  constructor(private readonly handoff: ActionBoundInput, private readonly send: Send, private readonly update?: UpdatePrivateCard) {}

  async request(action: string, actor: string, chat: string, source: string): Promise<void> {
    const issued = this.handoff.issue(action, actor, chat, source);
    for (const [id, owner] of this.cards) {
      if (owner.actor === actor && owner.chat === chat) {
        this.cards.delete(id);
        void this.update?.(id, statusCard(PRIVATE_INPUT_EXPIRED)).catch(() => {});
      }
    }
    const card = {
      schema: '2.0', config: { enable_forward: false, update_multi: true },
      header: { title: { tag: 'plain_text', content: this.handoff.action.title } },
      body: { elements: [
        { tag: 'markdown', content: `${this.handoff.action.description}\n输入仅交给本次操作；表单 5 分钟后失效。` },
        { tag: 'form', name: 'private_input', elements: [
          { tag: 'input', name: 'credential', input_type: 'password', required: true, placeholder: { tag: 'plain_text', content: '私密鉴权信息' } },
          { tag: 'button', name: 'submit_private', text: { tag: 'plain_text', content: '提交' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: issued.value }] },
        ] },
      ] },
    };
    const cardId = await this.send({ chatId: chat, type: 'card', card });
    if (typeof cardId !== 'string' || !cardId) {throw new Error('Private input card was not delivered');}
    this.cards.set(cardId, { actor, chat });
    this.handoff.bindCard(issued.nonce, cardId);
  }

  /** Unknown/restarted workflows never consume the input or enter ordinary routing. */
  static async reject(data: Record<string, unknown>, send: Send, update?: UpdatePrivateCard): Promise<void> {
    const context = data.context as { open_message_id?: unknown; open_chat_id?: unknown } | undefined;
    if (typeof context?.open_message_id !== 'string' || typeof context.open_chat_id !== 'string') {return;}
    // Updating is best effort; the separate status still reaches the chat when patching is unavailable.
    await update?.(context.open_message_id, statusCard(PRIVATE_INPUT_EXPIRED)).catch(() => {});
    await send({ chatId: context.open_chat_id, type: 'text', text: PRIVATE_INPUT_EXPIRED });
  }

  /** Detect before normal logging, including malformed/unknown forms. */
  static isPrivateCallback(data: Record<string, unknown>): boolean {
    const { action } = data;
    if (!action || typeof action !== 'object' || Array.isArray(action)) {return false;}
    const { value } = action as Record<string, unknown>;
    return 'form_value' in action || ('tag' in action && action.tag === 'input') ||
      Boolean(value && typeof value === 'object' && 'private_action' in value);
  }

  async submit(data: Record<string, unknown>): Promise<import('@disclaude/core').PrivateActionOutcome | undefined> {
    const context = data.context as { open_message_id?: string; open_chat_id?: string } | undefined;
    const operator = data.operator as { open_id?: string } | undefined;
    const action = data.action as { value?: Record<string, unknown>; form_value?: Record<string, unknown> } | undefined;
    if (typeof context?.open_message_id !== 'string' || typeof context.open_chat_id !== 'string' || typeof operator?.open_id !== 'string') {return;}
    const outcome = await this.handoff.submit({
      actor: operator.open_id, chat: context.open_chat_id, card: context.open_message_id,
      action: action?.value?.private_action, nonce: action?.value?.nonce, source: action?.value?.source,
      value: action?.form_value?.credential,
    });
    const text = outcome === 'succeeded' ? '本次鉴权操作已完成。'
      : outcome === 'denied' ? '本次鉴权操作未获授权，请检查所需权限。'
        : outcome === 'invalid' ? PRIVATE_INPUT_EXPIRED : '本次鉴权操作未完成，请稍后重新发起。';
    // A mismatched actor/card must not disable the legitimate owner's pending form.
    const owner = this.cards.get(context.open_message_id);
    if (!owner || (owner.actor === operator.open_id && owner.chat === context.open_chat_id)) {
      this.cards.delete(context.open_message_id);
      await this.update?.(context.open_message_id, statusCard(text)).catch(() => {});
    }
    await this.send({ chatId: context.open_chat_id, type: 'text', text });
    return outcome;
  }

  revoke(): void {
    this.handoff.revoke();
    for (const id of this.cards.keys()) {void this.update?.(id, statusCard(PRIVATE_INPUT_EXPIRED)).catch(() => {});}
    this.cards.clear();
  }
}
