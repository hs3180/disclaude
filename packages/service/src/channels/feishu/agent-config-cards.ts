/**
 * Feishu native configuration card for the chat's agent profile
 * (Issue #4914 / T-088): step-wise harness → model → thinking restricted
 * selectors over the configured preset catalog.
 *
 * `/agent config` → the control command delegates here through the channel
 * hook (`agentConfigUi`). The card is only a presenter: every option comes
 * from the same preset catalog as `/agent list` (`listAgentPresets`) and the
 * confirm step applies through the same chat-level selection service as
 * `/agent use` (`switchAgentPreset`) — no parallel selection state exists.
 * Card callbacks are handled DIRECTLY (never routed through the LLM agent),
 * following the /issue confirmation-card pattern.
 *
 * Authorization: the card is bound to the requesting actor+chat; a callback
 * from anyone else is ignored, and the host command policy
 * (`isCommandAllowed`) is re-checked on EVERY callback so a policy change
 * takes effect immediately (same contract as task-question cards).
 *
 * Dependency refresh: each step's options are recomputed from the current
 * partial selection on every repaint, so changing an upstream choice (e.g.
 * harness) refreshes the dependent model/thinking options before anything
 * is confirmed; the active profile only changes on the explicit apply step.
 *
 * Unknown: whether a real Feishu in-app menu entry can host this bot's card
 * is unverified — the verified entry is the `/agent config` command.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { ControlCommand } from '@disclaude/core';

const PREFIX = 'agent-config:';
const SELECT_NAME = 'agent_config_select';
/** Sentinel select value for presets whose LLM pins no reasoning effort. */
export const THINKING_DEFAULT = 'default';
/** A card that receives no callback within this window reads as expired. */
const TTL_MS = 10 * 60 * 1000;
/** Upper bound on tracked cards; finished ones are evicted first. */
const MAX_PENDING = 64;

export interface AgentConfigPresetOption {
  name: string;
  agentBackend: string;
  model: string;
  reasoningEffort?: string;
}

/** Ports to the SAME catalog and chat-level selection service as /agent. */
export interface FeishuAgentConfigAccess {
  listPresets(): AgentConfigPresetOption[];
  getActivePreset(chatId: string, threadRootId?: string): AgentConfigPresetOption | undefined;
  switchAgentPreset(
    chatId: string,
    presetName: string,
    threadRootId?: string
  ): { ok: true; active: AgentConfigPresetOption } | { ok: false; error: string };
  /** Host access policy, re-checked at callback time; absent = same openness as commands. */
  isCommandAllowed?(command: ControlCommand<'agent'>): boolean;
}

type Step = 'harness' | 'model' | 'thinking' | 'preset' | 'confirm';
type Phase = 'active' | 'applying' | 'applied' | 'cancelled' | 'denied' | 'failed' | 'superseded' | 'expired';

interface Selection {
  backend?: string;
  model?: string;
  effort?: string;
  preset?: string;
}

interface Pending {
  token: string;
  chatId: string;
  threadRootId?: string;
  actorId: string;
  card?: string;
  createdAt: number;
  phase: Phase;
  step: Step;
  selection: Selection;
  error?: string;
  active?: AgentConfigPresetOption;
  updates?: Promise<void>;
}

const plain = (content: string) => ({ tag: 'plain_text', content });
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// ---------------------------------------------------------------------------
// Pure cascade helpers (exported for tests): every option set is derived
// from the validated preset catalog, so only configured combinations exist.
// ---------------------------------------------------------------------------

/** Distinct harnesses (agent backends) that actually have presets. */
export function harnessChoices(presets: readonly AgentConfigPresetOption[]): string[] {
  return [...new Set(presets.map(p => p.agentBackend))];
}

/** Distinct model identifiers offered for one harness. */
export function modelChoices(presets: readonly AgentConfigPresetOption[], backend: string): string[] {
  return [...new Set(presets.filter(p => p.agentBackend === backend).map(p => p.model))];
}

/** Distinct thinking options for one harness+model; `default` = no pinned effort. */
export function thinkingChoices(presets: readonly AgentConfigPresetOption[], backend: string, model: string): string[] {
  const matches = presets.filter(p => p.agentBackend === backend && p.model === model);
  const efforts = [...new Set(matches.flatMap(p => (p.reasoningEffort ? [p.reasoningEffort] : [])))];
  return matches.some(p => !p.reasoningEffort) ? [THINKING_DEFAULT, ...efforts] : efforts;
}

/** Presets matching the partial selection (undefined dimension = any). */
export function presetsMatching(
  presets: readonly AgentConfigPresetOption[],
  selection: Readonly<Selection>
): AgentConfigPresetOption[] {
  return presets.filter(p =>
    (selection.backend === undefined || p.agentBackend === selection.backend) &&
    (selection.model === undefined || p.model === selection.model) &&
    (selection.effort === undefined ||
      (selection.effort === THINKING_DEFAULT ? p.reasoningEffort === undefined : p.reasoningEffort === selection.effort))
  );
}

const effortLabel = (effort: string | undefined): string => (effort === undefined ? '默认' : effort);

/** One-line profile summary reused by every card state. */
export function profileLine(preset: { name: string; agentBackend: string; model: string; reasoningEffort?: string }): string {
  return `**${preset.name}** — ${preset.agentBackend} / ${preset.model} / thinking: ${effortLabel(preset.reasoningEffort)}`;
}

/**
 * The step to render for a selection, auto-skipping dimensions that offer no
 * real choice (single model, single thinking option, unambiguous preset).
 */
export function resolveStep(
  presets: readonly AgentConfigPresetOption[],
  selection: Readonly<Selection>
): { step: Step; selection: Selection } {
  const sel: Selection = { ...selection };
  if (sel.backend === undefined) {
    return { step: 'harness', selection: sel };
  }
  if (sel.model === undefined) {
    const models = modelChoices(presets, sel.backend);
    if (models.length !== 1) {
      // 0 models means a stale backend (catalog changed); restart from step 1.
      return { step: models.length === 0 ? 'harness' : 'model', selection: models.length === 0 ? {} : { ...sel, model: undefined } };
    }
    const [onlyModel] = models;
    sel.model = onlyModel;
  }
  if (sel.effort === undefined) {
    const efforts = thinkingChoices(presets, sel.backend, sel.model);
    if (efforts.length > 1) {
      return { step: 'thinking', selection: sel };
    }
    const [onlyEffort] = efforts;
    sel.effort = onlyEffort;
  }
  const matches = presetsMatching(presets, sel);
  if (matches.length > 1) {
    return { step: 'preset', selection: { ...sel, preset: undefined } };
  }
  sel.preset = matches[0]?.name;
  return { step: 'confirm', selection: sel };
}

// ---------------------------------------------------------------------------
// Card construction (pure; exported for tests).
// ---------------------------------------------------------------------------

const STEP_LABEL: Record<Step, string> = {
  harness: '第 1 步 · 选择 harness',
  model: '第 2 步 · 选择 model',
  thinking: '第 3 步 · 选择 thinking',
  preset: '第 4 步 · 选择预设（同参数存在多个命名预设）',
  confirm: '最后一步 · 确认生效',
};

export interface CardView {
  phase: Phase;
  step: Step;
  selection: Readonly<Selection>;
  presets: readonly AgentConfigPresetOption[];
  active?: AgentConfigPresetOption;
  error?: string;
}

function stepOptions(view: CardView): Array<{ label: string; value: string }> {
  const { step, selection, presets } = view;
  if (step === 'harness') {
    return harnessChoices(presets).map(b => ({ label: b, value: b }));
  }
  if (step === 'model') {
    return modelChoices(presets, selection.backend as string).map(m => ({ label: m, value: m }));
  }
  if (step === 'thinking') {
    return thinkingChoices(presets, selection.backend as string, selection.model as string)
      .map(e => ({ label: e === THINKING_DEFAULT ? '默认（不指定）' : e, value: e }));
  }
  // 'preset': disambiguate presets sharing the same harness/model/thinking.
  return presetsMatching(presets, selection).map(p => ({ label: p.name, value: p.name }));
}

/** Build the card JSON for a view. Restricted options only — no free input. */
export function buildAgentConfigCard(token: string, view: CardView): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  elements.push({
    tag: 'markdown',
    content: `当前配置：${view.active ? profileLine(view.active) : '未配置命名预设（legacy `agent:` 配置）'}`,
  });

  if (view.phase === 'applied') {
    const applied = view.active ?? view.presets.find(p => p.name === view.selection.preset);
    elements.push(
      { tag: 'div', text: plain('✅ 已生效') },
      ...(applied ? [{ tag: 'markdown', content: profileLine(applied) }] : []),
      { tag: 'div', text: plain('将开始新的原生会话；上下文不跨预设迁移。选择保留至服务重启。') }
    );
    return finishCard(elements, 'green');
  }
  if (view.phase === 'cancelled') {
    elements.push({ tag: 'div', text: plain('已取消，当前选择保持不变。') });
    return finishCard(elements, 'grey');
  }
  if (view.phase === 'superseded') {
    elements.push({ tag: 'div', text: plain('已发送新的配置卡片，本卡片失效。') });
    return finishCard(elements, 'grey');
  }
  if (view.phase === 'expired') {
    elements.push({ tag: 'div', text: plain('配置卡片已过期，请重新发起 `/agent config`。') });
    return finishCard(elements, 'grey');
  }
  if (view.phase === 'denied') {
    elements.push({ tag: 'div', text: plain('当前权限不允许此操作，配置未变更。请联系服务维护者确认权限。') });
    return finishCard(elements, 'red');
  }
  if (view.phase === 'failed') {
    elements.push(
      { tag: 'div', text: plain(`生效失败：${view.error ?? '未知原因'}`) },
      { tag: 'div', text: plain('当前选择未变更，可重新选择或取消。') },
      { tag: 'button', name: `${PREFIX}${token}`, type: 'primary_filled', text: plain('重新选择'), value: { op: 'restart' } },
      { tag: 'button', name: `${PREFIX}${token}`, type: 'danger', text: plain('取消'), value: { op: 'cancel' } }
    );
    return finishCard(elements, 'red');
  }
  if (view.phase === 'applying') {
    elements.push({ tag: 'div', text: plain('正在应用选择…') });
    return finishCard(elements, 'blue');
  }

  // Phase 'active': render the current wizard step.
  const options = stepOptions(view);
  if (options.length === 0) {
    elements.push({ tag: 'div', text: plain('没有可选的预设，请联系服务维护者核对 agents/llms 配置。') });
    return finishCard(elements, 'grey');
  }
  if (view.step === 'confirm') {
    const preset = view.presets.find(p => p.name === view.selection.preset);
    elements.push(
      { tag: 'markdown', content: `${STEP_LABEL.confirm}：将切换到 ${preset ? profileLine(preset) : view.selection.preset ?? ''}` },
      { tag: 'div', text: plain('确认后开始新的原生会话；上下文不跨预设迁移；选择保留至服务重启（与 `/agent use` 相同）。') },
      { tag: 'button', name: `${PREFIX}${token}`, type: 'primary_filled', text: plain('确认生效'), value: { op: 'apply' } },
      { tag: 'button', name: `${PREFIX}${token}`, type: 'default', text: plain('重新选择'), value: { op: 'restart' } },
      { tag: 'button', name: `${PREFIX}${token}`, type: 'danger', text: plain('取消'), value: { op: 'cancel' } }
    );
    return finishCard(elements, 'blue');
  }

  const chosen: string[] = [];
  if (view.selection.backend && view.step !== 'harness') { chosen.push(`harness：${view.selection.backend}`); }
  if (view.selection.model && view.step !== 'model') { chosen.push(`model：${view.selection.model}`); }
  elements.push(
    { tag: 'div', text: plain(STEP_LABEL[view.step]) },
    ...(chosen.length ? [{ tag: 'div', text: plain(`已选 ${chosen.join(' · ')}；下方选项已按上述选择过滤。`) }] : []),
    {
      tag: 'form', name: `agent-config-form-${token}`, elements: [
        {
          tag: 'select_static', name: SELECT_NAME, required: true, placeholder: plain('请选择'),
          options: options.map(o => ({ text: plain(o.label), value: o.value })),
        },
        { tag: 'button', name: `${PREFIX}${token}`, type: 'primary_filled', text: plain('下一步'), form_action_type: 'submit', value: { op: 'next' } },
      ],
    },
    ...(view.step !== 'harness'
      ? [{ tag: 'button', name: `${PREFIX}${token}`, type: 'default', text: plain('上一步'), value: { op: 'back' } }]
      : []),
    { tag: 'button', name: `${PREFIX}${token}`, type: 'danger', text: plain('取消'), value: { op: 'cancel' } }
  );
  return finishCard(elements, 'blue');
}

function finishCard(elements: Record<string, unknown>[], template: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { enable_forward: false, update_multi: true },
    header: { title: plain('会话 Agent 配置'), template },
    body: { elements },
  };
}

// ---------------------------------------------------------------------------
// Card lifecycle + callback routing.
// ---------------------------------------------------------------------------

/** Create and track configuration cards; route their action callbacks. */
export class FeishuAgentConfigCards {
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly getAccess: () => FeishuAgentConfigAccess | undefined
  ) {}

  /** Match only card.action.trigger payloads whose action name carries our prefix. */
  static isCallback(data: Record<string, unknown>): boolean {
    const { name } = object(data.action);
    return typeof name === 'string' && name.startsWith(PREFIX);
  }

  /** Send a fresh configuration card for the requesting actor; resolves once delivered. */
  async open(target: { chatId: string; threadRootId?: string; actorId?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.closed) { return { ok: false, error: '配置卡片服务正在关闭' }; }
    const access = this.getAccess();
    if (!access) { return { ok: false, error: '配置服务不可用（agent 预设端口未接入）' }; }
    if (!target.actorId) { return { ok: false, error: '无法识别操作者；请从飞书聊天中发起' }; }
    const presets = access.listPresets();
    if (presets.length === 0) {
      return { ok: false, error: 'No named agent presets are configured (add an `agents:` map)' };
    }
    // One live card per actor+chat: supersede the previous one explicitly.
    for (const [token, p] of this.pending) {
      if (p.phase === 'active' && p.chatId === target.chatId && p.actorId === target.actorId) {
        p.phase = 'superseded';
        this.pending.delete(token);
        void this.paint(p).catch(() => {});
      }
    }
    if (this.pending.size >= MAX_PENDING) {
      for (const [token, p] of this.pending) {
        if (p.phase !== 'active' && p.phase !== 'applying') { this.pending.delete(token); }
        if (this.pending.size < MAX_PENDING) { break; }
      }
    }
    const token = randomUUID();
    const resolved = resolveStep(presets, {});
    const p: Pending = {
      token,
      chatId: target.chatId,
      ...(target.threadRootId ? { threadRootId: target.threadRootId } : {}),
      actorId: target.actorId,
      createdAt: Date.now(),
      phase: 'active',
      step: resolved.step,
      selection: resolved.selection,
    };
    this.pending.set(token, p);
    const content = JSON.stringify(buildAgentConfigCard(token, this.viewOf(p, access)));
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
      if (result.code !== 0 || !result.data?.message_id || result.data.chat_id !== target.chatId) {
        throw new Error('configuration card was not delivered');
      }
      p.card = result.data.message_id;
      return { ok: true };
    } catch (error) {
      this.pending.delete(token);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Handle a card callback directly (no agent turn involved). */
  async submit(data: Record<string, unknown>): Promise<void> {
    const action = object(data.action);
    const name = typeof action.name === 'string' ? action.name : '';
    if (!name.startsWith(PREFIX)) { return; }
    const token = name.slice(PREFIX.length);
    const p = this.pending.get(token);
    const context = object(data.context);
    const operator = object(data.operator).open_id;
    if (!p || context.open_chat_id !== p.chatId || context.open_message_id !== p.card) { return; }
    // Only the requester may operate; a group bystander's click is ignored.
    if (typeof operator !== 'string' || operator !== p.actorId) { return; }

    // Ops ride on plain-button `value` objects; a form submit may or may not
    // echo the button value depending on the card schema, so a carried
    // form_value always reads as the wizard's "next" op.
    const form = object(action.form_value);
    const { op: declaredOp } = object(action.value);
    const op = typeof declaredOp === 'string'
      ? declaredOp
      : (SELECT_NAME in form ? 'next' : undefined);
    // Terminal/in-flight states only re-assert their card — a replayed event
    // never triggers a second switch or reopens a closed flow.
    if (p.phase === 'applying' || p.phase === 'applied' ||
        (p.phase === 'failed' && op !== 'restart' && op !== 'cancel')) {
      await this.paint(p).catch(() => {});
      return;
    }
    if (Date.now() - p.createdAt > TTL_MS) {
      p.phase = 'expired';
      this.pending.delete(token);
      await this.paint(p).catch(() => {});
      return;
    }

    const access = this.getAccess();
    if (!access) { p.phase = 'expired'; await this.paint(p).catch(() => {}); return; }
    // Current host policy, re-checked on every callback (like task-question cards).
    if (access.isCommandAllowed && !access.isCommandAllowed({
      type: 'agent', chatId: p.chatId,
      ...(p.threadRootId ? { threadRootId: p.threadRootId } : {}),
      actorId: p.actorId,
      data: { subcommand: 'use', ...(p.selection.preset ? { preset: p.selection.preset } : {}) },
    })) {
      p.phase = 'denied';
      this.pending.delete(token);
      await this.paint(p).catch(() => {});
      return;
    }

    if (op === 'cancel') {
      p.phase = 'cancelled';
      this.pending.delete(token);
      await this.paint(p).catch(() => {});
      return;
    }
    if (op === 'restart') {
      p.phase = 'active';
      p.error = undefined;
      const resolved = resolveStep(access.listPresets(), {});
      p.step = resolved.step;
      p.selection = resolved.selection;
      await this.paint(p).catch(() => {});
      return;
    }
    if (op === 'back') {
      p.phase = 'active';
      p.error = undefined;
      // Dropping the downstream dimensions is what refreshes dependencies.
      p.selection = p.step === 'model' ? {}
        : p.step === 'thinking' ? { backend: p.selection.backend }
          : { backend: p.selection.backend, model: p.selection.model };
      const resolved = resolveStep(access.listPresets(), p.selection);
      p.step = resolved.step;
      p.selection = resolved.selection;
      await this.paint(p).catch(() => {});
      return;
    }
    if (op === 'next') {
      const value = form[SELECT_NAME];
      if (typeof value !== 'string' || !value) { await this.paint(p).catch(() => {}); return; }
      const presets = access.listPresets();
      const valid = p.step === 'harness' ? harnessChoices(presets)
        : p.step === 'model' ? modelChoices(presets, p.selection.backend as string)
          : p.step === 'thinking' ? thinkingChoices(presets, p.selection.backend as string, p.selection.model as string)
            : presetsMatching(presets, p.selection).map(x => x.name);
      if (!valid.includes(value)) { await this.paint(p).catch(() => {}); return; }
      const next: Selection =
        p.step === 'harness' ? { backend: value }
          : p.step === 'model' ? { backend: p.selection.backend, model: value }
            : p.step === 'thinking' ? { backend: p.selection.backend, model: p.selection.model, effort: value }
              : { ...p.selection, preset: value };
      const resolved = resolveStep(presets, next);
      p.phase = 'active';
      p.error = undefined;
      p.step = resolved.step;
      p.selection = resolved.selection;
      await this.paint(p).catch(() => {});
      return;
    }
    if (op === 'apply') {
      const presetName = p.selection.preset;
      const preset = presetName ? access.listPresets().find(x => x.name === presetName) : undefined;
      if (!preset) { await this.paint(p).catch(() => {}); return; }
      p.phase = 'applying';
      p.error = undefined;
      // Failure to repaint must not turn an explicit apply into a retry loop.
      await this.paint(p).catch(() => {});
      const result = access.switchAgentPreset(p.chatId, preset.name, p.threadRootId);
      if (result.ok) {
        p.phase = 'applied';
        p.active = result.active;
      } else {
        p.phase = 'failed';
        p.error = result.error;
      }
      await this.paint(p).catch(() => {});
      return;
    }
    // Unknown op (e.g. a select echo without form_value): re-assert the card.
    await this.paint(p).catch(() => {});
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
  }

  private viewOf(p: Pending, access: FeishuAgentConfigAccess): CardView {
    return {
      phase: p.phase,
      step: p.step,
      selection: p.selection,
      presets: access.listPresets(),
      active: p.active ?? access.getActivePreset(p.chatId, p.threadRootId),
      ...(p.error ? { error: p.error } : {}),
    };
  }

  /** Serialized per-card repaint so wizard steps can never render out of order. */
  private paint(p: Pending): Promise<void> {
    if (!p.card) { return Promise.resolve(); }
    const access = this.getAccess();
    if (!access) { return Promise.resolve(); }
    const messageId = p.card;
    p.updates = (p.updates ?? Promise.resolve()).catch(() => {}).then(async () => {
      const result = await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(buildAgentConfigCard(p.token, this.viewOf(p, access))) },
      });
      if (result.code !== 0) { throw new Error('Agent config card update failed'); }
    });
    return p.updates;
  }
}
