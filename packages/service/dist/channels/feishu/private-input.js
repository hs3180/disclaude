/** Transport only: action selection/policy and credential consumption belong
 * to the installed agent operation. Feishu does not know the auth provider,
 * target service or permission rules. Callback values bypass ordinary message
 * logging, agent prompts and conversation history.
 */
export class FeishuPrivateInput {
    handoff;
    send;
    constructor(handoff, send) {
        this.handoff = handoff;
        this.send = send;
    }
    async request(action, actor, chat, source) {
        const issued = this.handoff.issue(action, actor, chat, source);
        const card = {
            schema: '2.0', config: { enable_forward: false, update_multi: false },
            header: { title: { tag: 'plain_text', content: this.handoff.action.title } },
            body: { elements: [
                    { tag: 'markdown', content: `${this.handoff.action.description}\n输入仅交给本次操作；表单 5 分钟后失效。` },
                    { tag: 'form', name: 'private_input', elements: [
                            { tag: 'input', name: 'credential', input_type: 'password', required: true, placeholder: { tag: 'plain_text', content: '私密鉴权信息' } },
                            { tag: 'button', name: 'submit_private', text: { tag: 'plain_text', content: '提交' }, type: 'primary', action_type: 'form_submit', behaviors: [{ type: 'callback', value: issued.value }] },
                        ] },
                ] },
        };
        const cardId = await this.send({ chatId: chat, type: 'card', card });
        if (typeof cardId !== 'string' || !cardId) {
            throw new Error('Private input card was not delivered');
        }
        this.handoff.bindCard(issued.nonce, cardId);
    }
    /** Detect before normal logging, including malformed/unknown forms. */
    static isPrivateCallback(data) {
        const { action } = data;
        if (!action || typeof action !== 'object' || Array.isArray(action)) {
            return false;
        }
        const { value } = action;
        return 'form_value' in action || ('tag' in action && action.tag === 'input') ||
            Boolean(value && typeof value === 'object' && 'private_action' in value);
    }
    async submit(data) {
        const context = data.context;
        const operator = data.operator;
        const action = data.action;
        if (typeof context?.open_message_id !== 'string' || typeof context.open_chat_id !== 'string' || typeof operator?.open_id !== 'string') {
            return;
        }
        const outcome = await this.handoff.submit({
            actor: operator.open_id, chat: context.open_chat_id, card: context.open_message_id,
            action: action?.value?.private_action, nonce: action?.value?.nonce, source: action?.value?.source,
            value: action?.form_value?.credential,
        });
        const text = outcome === 'succeeded' ? '本次鉴权操作已完成。'
            : outcome === 'denied' ? '本次鉴权操作未获授权，请检查所需权限。'
                : outcome === 'invalid' ? '表单无效、已过期或已使用，请重新发起。' : '本次鉴权操作未完成，请稍后重新发起。';
        await this.send({ chatId: context.open_chat_id, type: 'text', text });
        return outcome;
    }
    revoke() { this.handoff.revoke(); }
}
