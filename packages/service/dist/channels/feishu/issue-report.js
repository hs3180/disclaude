/**
 * Feishu confirmation-card flow for one-click GitHub issue reporting
 * (Issue #5400, PR B).
 *
 * `/issue` → the control command reads the chat's last failure record and
 * calls `start()` here, which sends a card with the SANITIZED diagnostic
 * summary plus an optional user note field. Card callbacks are handled
 * DIRECTLY (never routed through the LLM agent), so reporting keeps working
 * when the agent runtime itself is the thing that failed.
 *
 * Terminal states are always painted on the card: submitted (with a clickable
 * issue link), cancelled, or failed with an explicit reason — the failure
 * record stays in the registry, and the failed card keeps a retry button so
 * nothing needs to be re-typed.
 */
import { randomUUID } from 'node:crypto';
import { sanitizeDiagnosticText, } from "../../../../core/dist/index.js";
import { SERVICE_VERSION } from '../../version.js';
const PREFIX = 'issue-report:';
const plain = (content) => ({ tag: 'plain_text', content });
const text = (content) => ({ tag: 'div', text: plain(content) });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
/** Failure summary block reused by the confirmation and submitted cards. */
function summaryLines(record) {
    return [
        `诊断 ID: ${record.diagnosticId}`,
        `分类: ${record.failureClass}；时间(UTC): ${record.timestamp}`,
        `Backend/Provider: ${record.backend ?? record.provider ?? 'unavailable'}`,
        `会话: ${record.sessionId ?? 'unavailable'}；消息: ${record.sourceMessageId ?? 'unavailable'}`,
        `错误: ${sanitizeDiagnosticText(record.detail)}`,
    ].join('\n');
}
/** Compose the GitHub issue title/body from a record + user note (all sanitized). */
export function composeIssueDraft(record, note) {
    const shortId = record.diagnosticId.slice(0, 8);
    // Records are sanitized at capture time; re-run defensively so a malformed
    // producer cannot leak auth material into a public issue.
    const detail = sanitizeDiagnosticText(record.detail);
    const headline = detail.split('\n')[0].slice(0, 80) || record.failureClass;
    const safeNote = note?.trim() ? sanitizeDiagnosticText(note) : undefined;
    const body = [
        '### 自动诊断摘要',
        `- 诊断 ID: \`${record.diagnosticId}\``,
        `- 分类: ${record.failureClass}`,
        `- 时间(UTC): ${record.timestamp}`,
        `- Backend/Provider: ${record.backend ?? record.provider ?? 'unavailable'}`,
        `- disclaude 版本: ${SERVICE_VERSION}`,
        `- 会话/消息: session ${record.sessionId ?? 'unavailable'}, message ${record.sourceMessageId ?? 'unavailable'}, chat ${record.chatId}`,
        '- 日志: 服务端 disclaude-combined 日志按诊断 ID 检索（或服务 stderr）；缺失字段以 unavailable 标记。',
        '',
        '### 错误详情',
        detail,
        '',
        '### 用户补充',
        safeNote ?? '（未填写）',
        '',
        '> 由 disclaude `/issue` 一键上报生成；诊断信息已脱敏，缺失信息明确标注，未编造原因或复现结论。',
    ].join('\n');
    return { title: `[feedback] ${record.failureClass}: ${headline} (diag ${shortId})`, body };
}
export class FeishuIssueReport {
    client;
    getIssueClient;
    pending = new Map();
    constructor(client, getIssueClient) {
        this.client = client;
        this.getIssueClient = getIssueClient;
    }
    static isCallback(data) {
        const { name } = object(data.action);
        return typeof name === 'string' && name.startsWith(PREFIX);
    }
    card(token, p) {
        const elements = [];
        const stateLabel = {
            waiting: '待确认 —— 提交前请核对脱敏摘要',
            submitting: '正在提交到 GitHub…',
            submitted: '✅ 已提交',
            failed: '❌ 提交失败（报告已保留，可重试）',
            cancelled: '已取消，未提交。',
        };
        elements.push(text(stateLabel[p.state]), text(summaryLines(p.record)));
        if (p.state === 'submitted' && p.issueUrl) {
            elements.push({ tag: 'markdown', content: `**Issue**: [${p.issueUrl}](${p.issueUrl})` });
        }
        if (p.error) {
            elements.push(text(`失败原因: ${p.error}`));
        }
        if (p.state === 'waiting') {
            elements.push(text('可在下方补充实际现象与期望行为（可选，随 issue 一起提交）：'), {
                tag: 'form',
                name: `issue_form_${token}`,
                elements: [
                    {
                        tag: 'input',
                        name: 'note',
                        input_type: 'multiline_text',
                        placeholder: plain('补充说明（可选）'),
                        ...(p.note ? { value: p.note } : {}),
                    },
                    {
                        tag: 'button',
                        name: `${PREFIX}${token}`,
                        type: 'primary_filled',
                        text: plain('确认提交 GitHub issue'),
                        form_action_type: 'submit',
                    },
                ],
            }, {
                tag: 'button',
                name: `${PREFIX}${token}`,
                type: 'danger',
                text: plain('取消'),
                value: { op: 'cancel' },
            });
        }
        if (p.state === 'failed') {
            elements.push({
                tag: 'button',
                name: `${PREFIX}${token}`,
                type: 'primary_filled',
                text: plain('重试提交'),
                value: { op: 'retry' },
            }, {
                tag: 'button',
                name: `${PREFIX}${token}`,
                type: 'danger',
                text: plain('取消'),
                value: { op: 'cancel' },
            });
        }
        return {
            schema: '2.0',
            config: { enable_forward: false, update_multi: true },
            header: {
                title: plain('GitHub issue 上报确认'),
                template: p.state === 'submitted' ? 'green' : p.state === 'failed' ? 'red' : 'blue',
            },
            body: { elements },
        };
    }
    async update(token, p) {
        if (!p.card) {
            return;
        }
        const messageId = p.card;
        const result = await this.client.im.message.patch({
            path: { message_id: messageId },
            data: { content: JSON.stringify(this.card(token, p)) },
        });
        if (result.code !== 0) {
            throw new Error('Issue report card update failed');
        }
    }
    /** Send the confirmation card for `record`; resolves once it is delivered. */
    async start(record, target) {
        const token = randomUUID();
        const p = { record, chatId: target.chatId, actorId: target.actorId, state: 'waiting' };
        this.pending.set(token, p);
        if (this.pending.size >= 64) {
            for (const [key, entry] of this.pending) {
                if (entry.state !== 'waiting' && entry.state !== 'submitting') {
                    this.pending.delete(key);
                }
                if (this.pending.size < 64) {
                    break;
                }
            }
        }
        const content = JSON.stringify(this.card(token, p));
        try {
            const result = target.threadRootId
                ? await this.client.im.message.reply({
                    path: { message_id: target.threadRootId },
                    data: { msg_type: 'interactive', content, reply_in_thread: true },
                })
                : await this.client.im.message.create({
                    params: { receive_id_type: 'chat_id' },
                    data: { receive_id: target.chatId, msg_type: 'interactive', content },
                });
            if (result.code !== 0 || !result.data?.message_id) {
                throw new Error('confirmation card was not delivered');
            }
            p.card = result.data.message_id;
            return { ok: true };
        }
        catch (error) {
            this.pending.delete(token);
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    /** Handle a card callback directly (no agent turn involved). */
    async submit(data) {
        const action = object(data.action);
        const { name } = action;
        if (typeof name !== 'string') {
            return;
        }
        const token = name.slice(PREFIX.length);
        const p = this.pending.get(token);
        const context = object(data.context);
        const operator = object(data.operator).open_id;
        if (!p || context.open_chat_id !== p.chatId) {
            return;
        }
        // Only the requester may confirm; a group bystander's click is ignored.
        if (p.actorId && operator !== p.actorId) {
            return;
        }
        const { op } = object(action.value);
        if (op === 'cancel') {
            if (p.state === 'submitting') {
                return;
            }
            p.state = 'cancelled';
            p.error = undefined;
            await this.update(token, p).catch(() => { });
            return;
        }
        if (p.state === 'submitting' || p.state === 'submitted') {
            await this.update(token, p).catch(() => { });
            return;
        }
        if (p.state !== 'waiting' && p.state !== 'failed') {
            return;
        }
        const form = object(action.form_value);
        if (typeof form.note === 'string' && form.note.trim()) {
            p.note = form.note;
        }
        const issueClient = this.getIssueClient();
        if (!issueClient) {
            p.state = 'failed';
            p.error = 'GitHub 上报未配置（github 配置段缺失或不完整）';
            await this.update(token, p).catch(() => { });
            return;
        }
        p.state = 'submitting';
        p.error = undefined;
        // Failure to repaint must not turn an explicit confirm into a retry loop.
        await this.update(token, p).catch(() => { });
        const draft = composeIssueDraft(p.record, p.note);
        const result = await issueClient.ensureIssue({ ...draft, diagnosticId: p.record.diagnosticId });
        if (result.ok) {
            p.state = 'submitted';
            p.issueUrl = result.issueUrl;
        }
        else {
            p.state = 'failed';
            p.error = {
                auth: 'GitHub 鉴权失败（App 凭据或安装配置），未提交。',
                network: '网络请求失败（无法访问 GitHub），未提交。',
                other: `提交未完成：${result.error}`,
            }[result.kind];
        }
        await this.update(token, p).catch(() => { });
    }
    close() {
        for (const p of this.pending.values()) {
            if (p.state === 'waiting' || p.state === 'submitting') {
                p.state = 'cancelled';
            }
        }
        this.pending.clear();
    }
}
