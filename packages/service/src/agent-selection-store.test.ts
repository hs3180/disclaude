import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AgentPresets } from '@disclaude/core';
import type { ChatAgentCallbacks } from './agents/types.js';
import { AgentSelectionStore } from './agent-selection-store.js';
import { AgentFactory } from './agents/factory.js';
import { ChatSessionPool } from './chat-session-pool.js';

vi.mock('./agents/factory.js', () => ({
  AgentFactory: {
    resolveConfig: vi.fn(() => ({ apiKey: 'test-key', model: '' })),
    createChatAgent: vi.fn((_name: string, chatId: string) => ({
      chatId, dispose: vi.fn(), reset: vi.fn(), isBusy: false, hasPendingWork: false,
      updateCallbacks: vi.fn(),
    })),
  },
}));

const presets: AgentPresets = {
  global: { agentBackend: 'claude', model: 'global-model', apiKey: 'k', llm: 'g' },
  app: { agentBackend: 'pi', model: 'app-model', apiKey: 'k', llm: 'a' },
  saved: { agentBackend: 'codex', model: 'gpt-6.1-sol', apiKey: '', llm: 'b' },
  explicit: { agentBackend: 'codex', model: 'explicit-model', apiKey: 'k', llm: 'e' },
};
const callbacks = (): ChatAgentCallbacks => ({
  sendMessage: vi.fn(), sendCard: vi.fn(), sendFile: vi.fn(), onDone: vi.fn(),
});

describe('durable per-chat agent selections from /agent use (#5476)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-selections-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('saves the switch per chat, resolves it above per-app, and recovers after restart', () => {
    const file = join(dir, 'agent-selections.json');
    const pool = new ChatSessionPool({
      agentPresets: presets,
      agentSelections: new AgentSelectionStore(file),
      defaultAgentPresetForChat: chatId => chatId === 'wechat-chat' ? 'app' : undefined,
      validatePresetBackend: () => ({ available: true }),
    });
    expect(pool.getActiveAgentPreset('wechat-chat')).toMatchObject({ name: 'app', model: 'app-model' });
    expect(pool.getActiveAgentPreset('feishu-chat')).toMatchObject({ name: 'global', model: 'global-model' });
    expect(pool.switchAgentPreset('wechat-chat', 'saved', undefined, 'ou_user')).toMatchObject({ ok: true });
    expect(pool.getActiveAgentPreset('wechat-chat')).toMatchObject({ name: 'saved', model: 'gpt-6.1-sol' });
    pool.disposeAll();

    const restarted = new ChatSessionPool({
      agentPresets: presets,
      agentSelections: new AgentSelectionStore(file),
      defaultAgentPresetForChat: chatId => chatId === 'wechat-chat' ? 'app' : undefined,
    });
    expect(restarted.getActiveAgentPreset('wechat-chat')).toMatchObject({ name: 'saved', model: 'gpt-6.1-sol' });
    // The next message after the restart reuses the saved choice without a
    // new /agent use (the created agent runs the saved preset).
    restarted.getOrCreateChatAgent('wechat-chat', callbacks());
    expect(vi.mocked(AgentFactory.createChatAgent).mock.calls.at(-1)![3]).toMatchObject({ model: 'gpt-6.1-sol' });
    // A chat that never switched keeps the per-app/global defaults.
    restarted.getOrCreateChatAgent('feishu-chat', callbacks());
    expect(vi.mocked(AgentFactory.createChatAgent).mock.calls.at(-1)![3]).toMatchObject({ model: 'global-model' });
    expect(new AgentSelectionStore(file).get('wechat-chat')).toMatchObject({ presetName: 'saved', updatedBy: 'ou_user' });
    restarted.disposeAll();
  });

  it('refuses the switch while a session is busy and persists nothing', () => {
    const store = new AgentSelectionStore(join(dir, 'agent-selections.json'));
    const pool = new ChatSessionPool({
      agentPresets: presets,
      agentSelections: store,
      validatePresetBackend: () => ({ available: true }),
    });
    const busy = pool.getOrCreateChatAgent('chat', callbacks());
    (busy as unknown as { isBusy: boolean }).isBusy = true;
    expect(pool.switchAgentPreset('chat', 'saved', undefined, 'ou_user')).toMatchObject({ ok: false });
    expect(store.get('chat')).toBeUndefined();
    (busy as unknown as { isBusy: boolean }).isBusy = false;
    expect(pool.switchAgentPreset('chat', 'saved', undefined, 'ou_user')).toMatchObject({ ok: true });
    expect(busy.dispose).toHaveBeenCalled();
    pool.getOrCreateChatAgent('chat', callbacks());
    expect(vi.mocked(AgentFactory.createChatAgent).mock.calls.at(-1)![3]).toMatchObject({ model: 'gpt-6.1-sol' });
    pool.disposeAll();
  });

  it('keeps a sibling thread own switch above the chat-wide save and resets selection-following sessions', () => {
    const pool = new ChatSessionPool({
      agentPresets: presets,
      agentSelections: new AgentSelectionStore(join(dir, 'agent-selections.json')),
      validatePresetBackend: () => ({ available: true }),
    });
    pool.getOrCreateChatAgent('chat', callbacks(), 'om_topic');
    expect(pool.switchAgentPreset('chat', 'explicit', 'om_topic', 'ou_thread')).toMatchObject({ ok: true });
    const thread = pool.get('chat', 'om_topic')!;
    const main = pool.getOrCreateChatAgent('chat', callbacks());
    expect(pool.switchAgentPreset('chat', 'saved', undefined, 'ou_main')).toMatchObject({ ok: true });
    // The thread's own explicit switch outranks the chat-wide saved choice.
    expect(pool.getActiveAgentPreset('chat', 'om_topic')).toMatchObject({ name: 'explicit', model: 'explicit-model' });
    expect(pool.getActiveAgentPreset('chat')).toMatchObject({ name: 'saved', model: 'gpt-6.1-sol' });
    expect(thread.dispose).not.toHaveBeenCalled();
    expect(main.dispose).toHaveBeenCalled();
    pool.disposeAll();
  });

  it('leaves the session untouched when the durable save fails', () => {
    const store = new AgentSelectionStore(join(dir, 'agent-selections.json'));
    store.set = () => { throw new Error('disk full'); };
    const pool = new ChatSessionPool({
      agentPresets: presets,
      agentSelections: store,
      validatePresetBackend: () => ({ available: true }),
    });
    const agent = pool.getOrCreateChatAgent('chat', callbacks());
    const result = pool.switchAgentPreset('chat', 'saved', undefined, 'ou_user');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Could not save the agent selection') });
    expect(agent.dispose).not.toHaveBeenCalled();
    expect(pool.getActiveAgentPreset('chat')).toMatchObject({ name: 'global', model: 'global-model' });
    pool.disposeAll();
  });

  it('rejects a corrupt persisted document instead of silently dropping selections', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-selections.json'), '{"version":1,"selections":{"chat":{"presetName":""}}}', { mode: 0o600 });
    expect(() => new AgentSelectionStore(join(dir, 'agent-selections.json'))).toThrow(/Invalid agent selections/);
  });
});
