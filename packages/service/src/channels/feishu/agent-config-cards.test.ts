/**
 * Tests for FeishuAgentConfigCards (Issue #4914 / T-088).
 *
 * Covers the equivalent delivery chain for the native config card:
 * pure cascade/options derivation, card construction (restricted selectors
 * only), callback routing/state machine, authorization (requester binding +
 * current host policy), dependency refresh on upstream changes, idempotent
 * applies, and the shared selection-service contract (same
 * list/get/switch ports the /agent command consumes).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@larksuiteoapi/node-sdk';
import {
  FeishuAgentConfigCards,
  buildAgentConfigCard,
  harnessChoices,
  modelChoices,
  presetsMatching,
  resolveStep,
  thinkingChoices,
  THINKING_DEFAULT,
  type AgentConfigPresetOption,
  type FeishuAgentConfigAccess,
} from './agent-config-cards.js';

const TOKEN = '11111111-1111-4111-8111-111111111111';
const PRESETS: AgentConfigPresetOption[] = [
  { name: 'claude-main', agentBackend: 'claude', model: 'claude-opus-5' },
  { name: 'codex-fast', agentBackend: 'codex', model: 'gpt-5.1', reasoningEffort: 'low' },
  { name: 'codex-deep', agentBackend: 'codex', model: 'gpt-5.1', reasoningEffort: 'high' },
  { name: 'codex-lite', agentBackend: 'codex', model: 'gpt-5-mini' },
];

function access(overrides: Partial<FeishuAgentConfigAccess> = {}): FeishuAgentConfigAccess {
  return {
    listPresets: () => PRESETS,
    getActivePreset: () => PRESETS[0],
    switchAgentPreset: vi.fn().mockReturnValue({ ok: true, active: PRESETS[2] }),
    ...overrides,
  };
}

interface FakeCall { path?: { message_id?: string }; params?: { receive_id_type?: string }; data?: { receive_id?: string; msg_type?: string; content?: string } }

function fakeClient(chatId = 'oc_chat') {
  const calls: { create: FakeCall[]; reply: FakeCall[]; patch: FakeCall[] } = { create: [], reply: [], patch: [] };
  let seq = 0;
  const client = {
    calls,
    lastMessageId: () => `om_${seq}`,
    im: {
      message: {
        create: vi.fn((req: FakeCall) => {
          calls.create.push(req);
          return Promise.resolve({ code: 0, data: { message_id: `om_${++seq}`, chat_id: req.data?.receive_id ?? chatId } });
        }),
        reply: vi.fn((req: FakeCall) => {
          calls.reply.push(req);
          return Promise.resolve({ code: 0, data: { message_id: `om_${++seq}`, chat_id: chatId } });
        }),
        patch: vi.fn((req: FakeCall) => {
          calls.patch.push(req);
          return Promise.resolve({ code: 0 });
        }),
      },
    },
  };
  return client as unknown as Client & typeof client;
}

/** Extract the wizard token from a delivered/patched card payload. */
function tokenOf(content: string | undefined): string {
  const match = /agent-config:([0-9a-f-]{36})/.exec(content ?? '');
  if (!match) { throw new Error('no agent-config token found in card'); }
  return match[1];
}

const cardContent = (call: FakeCall): string => String(call.data?.content);

const cardJson = (call: FakeCall): { body?: { elements?: Array<Record<string, unknown>> } } =>
  JSON.parse(cardContent(call)) as { body?: { elements?: Array<Record<string, unknown>> } };

const selectValues = (parsed: ReturnType<typeof cardJson>): string[] => {
  const form = parsed.body?.elements?.find(e => e.tag === 'form') as { elements?: Array<Record<string, unknown>> } | undefined;
  const select = form?.elements?.find(e => e.tag === 'select_static') as { options?: Array<{ value: string }> } | undefined;
  return select?.options?.map(o => o.value) ?? [];
};

function click(overrides: {
  token: string; op: string; formValue?: Record<string, unknown>;
  actor?: string; chatId?: string; messageId?: string;
}) {
  return {
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    action: {
      name: `agent-config:${overrides.token}`,
      tag: 'button',
      value: { op: overrides.op },
      ...(overrides.formValue ? { form_value: overrides.formValue } : {}),
    },
    context: { open_message_id: overrides.messageId ?? 'om_1', open_chat_id: overrides.chatId ?? 'oc_chat' },
    operator: { open_id: overrides.actor ?? 'ou_actor', user_id: 'uid', union_id: 'on' },
  } as unknown as Record<string, unknown>;
}

/** Open a card and return the handler + its token/card message id. */
async function openedCard(ports: FeishuAgentConfigAccess, client: ReturnType<typeof fakeClient>,
  target: { chatId?: string; threadRootId?: string; actorId?: string } = {}) {
  const cards = new FeishuAgentConfigCards(client, () => ports);
  const result = await cards.open({
    chatId: target.chatId ?? 'oc_chat',
    ...(target.threadRootId ? { threadRootId: target.threadRootId } : {}),
    actorId: target.actorId ?? 'ou_actor',
  });
  expect(result).toEqual({ ok: true });
  const sent = (client.calls.create.length ? client.calls.create : client.calls.reply).at(-1)!;
  return { cards, token: tokenOf(sent.data?.content), messageId: client.lastMessageId() };
}

describe('cascade helpers (restricted options from the catalog only)', () => {
  it('derives harness options from configured backends only', () => {
    expect(harnessChoices(PRESETS)).toEqual(['claude', 'codex']);
  });

  it('restricts model options to the chosen harness', () => {
    expect(modelChoices(PRESETS, 'claude')).toEqual(['claude-opus-5']);
    expect(modelChoices(PRESETS, 'codex')).toEqual(['gpt-5.1', 'gpt-5-mini']);
  });

  it('restricts thinking options to the chosen harness+model, defaulting when no effort is pinned', () => {
    expect(thinkingChoices(PRESETS, 'codex', 'gpt-5.1')).toEqual(['low', 'high']);
    expect(thinkingChoices(PRESETS, 'codex', 'gpt-5-mini')).toEqual([THINKING_DEFAULT]);
    expect(thinkingChoices(PRESETS, 'claude', 'claude-opus-5')).toEqual([THINKING_DEFAULT]);
  });

  it('matches presets by partial selection with the default sentinel meaning "no pinned effort"', () => {
    expect(presetsMatching(PRESETS, { backend: 'codex', model: 'gpt-5.1', effort: 'high' }).map(p => p.name))
      .toEqual(['codex-deep']);
    expect(presetsMatching(PRESETS, { backend: 'codex', model: 'gpt-5-mini', effort: THINKING_DEFAULT }).map(p => p.name))
      .toEqual(['codex-lite']);
  });

  it('auto-skips dimensions without a real choice', () => {
    const solo = [{ name: 'solo', agentBackend: 'pi', model: 'm1' }];
    expect(resolveStep(solo, { backend: 'pi' })).toEqual({
      step: 'confirm', selection: { backend: 'pi', model: 'm1', effort: THINKING_DEFAULT, preset: 'solo' },
    });
    expect(resolveStep(PRESETS, { backend: 'codex' }).step).toBe('model');
    expect(resolveStep(PRESETS, { backend: 'codex', model: 'gpt-5.1' }).step).toBe('thinking');
  });

  it('offers a preset disambiguation step when parameters map to several named presets', () => {
    const twins = [...PRESETS, { name: 'codex-deep-2', agentBackend: 'codex', model: 'gpt-5.1', reasoningEffort: 'high' }];
    const resolved = resolveStep(twins, { backend: 'codex', model: 'gpt-5.1', effort: 'high' });
    expect(resolved.step).toBe('preset');
    expect(resolved.selection.preset).toBeUndefined();
  });
});

describe('buildAgentConfigCard', () => {
  const base = { phase: 'active' as const, presets: PRESETS, active: PRESETS[0] };

  it('renders restricted selectors only — no free-text input anywhere', () => {
    const card = buildAgentConfigCard(TOKEN, { ...base, step: 'model', selection: { backend: 'codex' } });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"input"');
    // Only catalog models for the chosen harness — no hand-typed model IDs.
    expect(selectValues(card as unknown as ReturnType<typeof cardJson>)).toEqual(['gpt-5.1', 'gpt-5-mini']);
  });

  it('always shows the current chat profile for viewing', () => {
    const card = buildAgentConfigCard(TOKEN, { ...base, step: 'harness', selection: {} });
    const json = JSON.stringify(card);
    expect(json).toContain('claude-main');
    expect(json).toContain('claude-opus-5');
    expect(json).toContain('thinking: 默认');
  });

  it('marks empty catalogs and terminal states without interactive controls', () => {
    const empty = buildAgentConfigCard(TOKEN, { phase: 'active', step: 'harness', selection: {}, presets: [], active: undefined });
    expect(JSON.stringify(empty)).toContain('没有可选的预设');
    const cancelled = buildAgentConfigCard(TOKEN, { ...base, step: 'confirm', selection: {}, phase: 'cancelled' });
    expect(JSON.stringify(cancelled)).toContain('已取消');
    expect(JSON.stringify(cancelled)).not.toContain('"tag":"button"');
  });

  it('confirm step names the resolved preset and keeps apply/restart/cancel callbacks', () => {
    const card = buildAgentConfigCard(TOKEN, {
      ...base, step: 'confirm',
      selection: { backend: 'codex', model: 'gpt-5.1', effort: 'high', preset: 'codex-deep' },
    });
    const json = JSON.stringify(card);
    expect(json).toContain('codex-deep');
    const buttons = (card.body as { elements: Array<Record<string, unknown> & { value?: { op?: string } }> }).elements
      .filter(e => e.tag === 'button').map(e => e.value?.op);
    expect(buttons).toEqual(['apply', 'restart', 'cancel']);
  });
});

describe('FeishuAgentConfigCards flow', () => {
  it('delivers a card and walks harness → model → thinking → confirm → apply through the shared selection service', async () => {
    const client = fakeClient();
    const sw = vi.fn().mockReturnValue({ ok: true, active: PRESETS[2] });
    const ports = access({ switchAgentPreset: sw });
    const { cards, token, messageId } = await openedCard(ports, client);

    expect(client.calls.create).toHaveLength(1);
    expect(cardContent(client.calls.create[0])).toContain('claude-main');

    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'codex' }, messageId }));
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'gpt-5.1' }, messageId }));
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'high' }, messageId }));
    const confirm = cardContent(client.calls.patch.at(-1)!);
    expect(confirm).toContain('codex-deep');
    expect(confirm).toContain('确认生效');

    await cards.submit(click({ token, op: 'apply', messageId }));
    expect(sw).toHaveBeenCalledExactlyOnceWith('oc_chat', 'codex-deep', undefined);
    const applied = cardContent(client.calls.patch.at(-1)!);
    expect(applied).toContain('已生效');
    expect(applied).toContain('gpt-5.1');
    expect(applied).toContain('high');
  });

  it('replies in-thread when opened from a topic thread and scopes the switch to it', async () => {
    const client = fakeClient();
    const sw = vi.fn().mockReturnValue({ ok: true, active: PRESETS[1] });
    const ports = access({ switchAgentPreset: sw });
    const cards = new FeishuAgentConfigCards(client, () => ports);
    const result = await cards.open({ chatId: 'oc_chat', threadRootId: 'om_topic', actorId: 'ou_actor' });
    expect(result).toEqual({ ok: true });
    expect(client.calls.reply).toHaveLength(1);
    const token = tokenOf(client.calls.reply[0].data?.content);
    // Single-preset harness (claude) auto-advances to confirm after the pick.
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'claude' }, messageId: 'om_1' }));
    await cards.submit(click({ token, op: 'apply', messageId: 'om_1' }));
    expect(sw).toHaveBeenCalledWith('oc_chat', 'claude-main', 'om_topic');
  });

  it('refreshes dependent options when an upstream choice changes before confirm', async () => {
    const client = fakeClient();
    const { cards, token, messageId } = await openedCard(access(), client);
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'codex' }, messageId }));
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'gpt-5.1' }, messageId }));
    // Thinking step; go back to the model step — options still scoped to codex.
    await cards.submit(click({ token, op: 'back', messageId }));
    expect(selectValues(cardJson(client.calls.patch.at(-1)!))).toEqual(['gpt-5.1', 'gpt-5-mini']);
    // Back once more and pick the other harness: its model/thinking refresh.
    await cards.submit(click({ token, op: 'back', messageId }));
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'claude' }, messageId }));
    const after = cardContent(client.calls.patch.at(-1)!);
    expect(after).toContain('claude-main');
    expect(after).toContain('确认生效');
  });

  it('ignores callbacks from anyone but the requesting actor (group bystander)', async () => {
    const client = fakeClient();
    const sw = vi.fn().mockReturnValue({ ok: true, active: PRESETS[0] });
    const ports = access({ switchAgentPreset: sw });
    const { cards, token, messageId } = await openedCard(ports, client);
    const patchesBefore = client.calls.patch.length;
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'codex' }, actor: 'ou_bystander', messageId }));
    await cards.submit(click({ token, op: 'cancel', actor: 'ou_bystander', messageId }));
    expect(client.calls.patch.length).toBe(patchesBefore);
    expect(sw).not.toHaveBeenCalled();
    // The rightful actor can still drive the card afterwards.
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'claude' }, messageId }));
    expect(cardContent(client.calls.patch.at(-1)!)).toContain('确认生效');
  });

  it('re-checks the host policy on every callback and denies when it changed', async () => {
    const client = fakeClient();
    const isCommandAllowed = vi.fn().mockReturnValue(true);
    const sw = vi.fn().mockReturnValue({ ok: true, active: PRESETS[0] });
    const ports = access({ switchAgentPreset: sw, isCommandAllowed });
    const { cards, token, messageId } = await openedCard(ports, client);
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'claude' }, messageId }));
    expect(isCommandAllowed).toHaveBeenCalledTimes(1);
    isCommandAllowed.mockReturnValue(false);
    await cards.submit(click({ token, op: 'apply', messageId }));
    expect(sw).not.toHaveBeenCalled();
    expect(cardContent(client.calls.patch.at(-1)!)).toContain('权限不允许');
  });

  it('applies exactly once for replayed apply events (idempotent terminal state)', async () => {
    const client = fakeClient();
    const sw = vi.fn().mockReturnValue({ ok: true, active: PRESETS[0] });
    const ports = access({ switchAgentPreset: sw });
    const { cards, token, messageId } = await openedCard(ports, client);
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'claude' }, messageId }));
    await cards.submit(click({ token, op: 'apply', messageId }));
    await cards.submit(click({ token, op: 'apply', messageId }));
    await cards.submit(click({ token, op: 'apply', messageId }));
    expect(sw).toHaveBeenCalledOnce();
    expect(cardContent(client.calls.patch.at(-1)!)).toContain('已生效');
  });

  it('paints a failed state with recovery when the shared switch service rejects', async () => {
    const client = fakeClient();
    const sw = vi.fn().mockReturnValue({ ok: false, error: 'The current chat is busy; wait for the response or use /stop before switching presets' });
    const ports = access({ switchAgentPreset: sw });
    const { cards, token, messageId } = await openedCard(ports, client);
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'claude' }, messageId }));
    await cards.submit(click({ token, op: 'apply', messageId }));
    const failed = cardContent(client.calls.patch.at(-1)!);
    expect(failed).toContain('The current chat is busy');
    expect(failed).toContain('重新选择');
    // Restart returns to the harness step for a different choice.
    await cards.submit(click({ token, op: 'restart', messageId }));
    expect(cardContent(client.calls.patch.at(-1)!)).toContain('第 1 步');
  });

  it('rejects select values outside the current step catalog (no forged selections)', async () => {
    const client = fakeClient();
    const sw = vi.fn().mockReturnValue({ ok: true, active: PRESETS[0] });
    const ports = access({ switchAgentPreset: sw });
    const { cards, token, messageId } = await openedCard(ports, client);
    // gpt-5.1 is a model, not a harness — the harness step must not advance.
    await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'gpt-5.1' }, messageId }));
    expect(selectValues(cardJson(client.calls.patch.at(-1)!))).toEqual(['claude', 'codex']);
    expect(sw).not.toHaveBeenCalled();
  });

  it('expires a card that receives no callback within the TTL window', async () => {
    const client = fakeClient();
    const ports = access();
    const cards = new FeishuAgentConfigCards(client, () => ports);
    await cards.open({ chatId: 'oc_chat', actorId: 'ou_actor' });
    const token = tokenOf(client.calls.create[0].data?.content);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    try {
      await cards.submit(click({ token, op: 'next', formValue: { agent_config_select: 'claude' } }));
    } finally { now.mockRestore(); }
    expect(cardContent(client.calls.patch.at(-1)!)).toContain('已过期');
  });

  it('supersedes the previous live card for the same actor+chat', async () => {
    const client = fakeClient();
    const ports = access();
    const cards = new FeishuAgentConfigCards(client, () => ports);
    await cards.open({ chatId: 'oc_chat', actorId: 'ou_actor' });
    const firstToken = tokenOf(client.calls.create[0].data?.content);
    await cards.open({ chatId: 'oc_chat', actorId: 'ou_actor' });
    expect(cardContent(client.calls.patch[0])).toContain('新的配置卡片');
    // The superseded card no longer accepts operations.
    await cards.submit(click({ token: firstToken, op: 'next', formValue: { agent_config_select: 'claude' } }));
    expect(client.calls.patch).toHaveLength(1);
  });

  it('refuses to open without presets or without an identified actor', async () => {
    const client = fakeClient();
    const empty = new FeishuAgentConfigCards(client, () => access({ listPresets: () => [] }));
    await expect(empty.open({ chatId: 'oc_chat', actorId: 'ou_actor' })).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('No named agent presets'),
    });
    const cards = new FeishuAgentConfigCards(client, () => access());
    await expect(cards.open({ chatId: 'oc_chat' })).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('无法识别操作者'),
    });
    expect(client.calls.create).toHaveLength(0);
  });

  it('advances the wizard even when the form submit callback carries no button value', async () => {
    const client = fakeClient();
    const ports = access();
    const { cards, token, messageId } = await openedCard(ports, client);
    // Some card schemas echo only the form_value on submit — op must be derived.
    await cards.submit({
      action: { name: `agent-config:${token}`, tag: 'button', form_value: { agent_config_select: 'codex' } },
      context: { open_message_id: messageId, open_chat_id: 'oc_chat' },
      operator: { open_id: 'ou_actor' },
    });
    const modelCard = cardJson(client.calls.patch.at(-1)!);
    expect(selectValues(modelCard)).toEqual(['gpt-5.1', 'gpt-5-mini']);
  });

  it('does not match foreign callbacks', () => {
    expect(FeishuAgentConfigCards.isCallback({ action: { name: 'submit_private' } })).toBe(false);
    expect(FeishuAgentConfigCards.isCallback({ action: { form_value: { x: 1 } } })).toBe(false);
    expect(FeishuAgentConfigCards.isCallback({ action: { name: 'agent-config:abc' } })).toBe(true);
  });
});
