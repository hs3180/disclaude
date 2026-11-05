import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AgentPresets } from '@disclaude/core';
import type { ChatAgentCallbacks } from './agents/types.js';
import { AgentBindingStore } from './agent-binding-store.js';
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
  bound: { agentBackend: 'codex', model: 'gpt-6.1-sol', apiKey: '', llm: 'b' },
  explicit: { agentBackend: 'dsh', model: 'explicit-model', apiKey: 'k', llm: 'e' },
};
const callbacks = (): ChatAgentCallbacks => ({
  sendMessage: vi.fn(), sendCard: vi.fn(), sendFile: vi.fn(), onDone: vi.fn(),
});

describe('durable chat agent bindings (#5476)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-bindings-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('resolves /agent use > durable binding > per-app > global and recovers after restart', () => {
    const file = join(dir, 'agent-bindings.json');
    const pool = new ChatSessionPool({
      agentPresets: presets,
      agentBindings: new AgentBindingStore(file),
      defaultAgentPresetForChat: chatId => chatId === 'wechat-chat' ? 'app' : undefined,
      validatePresetBackend: () => ({ available: true }),
    });
    expect(pool.getActiveAgentPreset('wechat-chat')).toMatchObject({ name: 'app', model: 'app-model' });
    expect(pool.setAgentBinding('wechat-chat', 'bound', 'ou_admin')).toMatchObject({
      ok: true, binding: { presetName: 'bound', updatedBy: 'ou_admin' },
    });
    expect(pool.getActiveAgentPreset('wechat-chat')).toMatchObject({ name: 'bound', model: 'gpt-6.1-sol' });
    expect(pool.switchAgentPreset('wechat-chat', 'explicit')).toMatchObject({ ok: true });
    expect(pool.getActiveAgentPreset('wechat-chat')).toMatchObject({ name: 'explicit', model: 'explicit-model' });
    pool.disposeAll();

    const restarted = new ChatSessionPool({
      agentPresets: presets,
      agentBindings: new AgentBindingStore(file),
      defaultAgentPresetForChat: chatId => chatId === 'wechat-chat' ? 'app' : undefined,
    });
    expect(restarted.getActiveAgentPreset('wechat-chat')).toMatchObject({ name: 'bound', model: 'gpt-6.1-sol' });
    expect(restarted.clearAgentBinding('wechat-chat')).toMatchObject({ ok: true, binding: { presetName: 'bound' } });
    expect(restarted.getActiveAgentPreset('wechat-chat')).toMatchObject({ name: 'app', model: 'app-model' });
    restarted.disposeAll();
  });

  it('applies a binding on the next message and refuses while the affected session is busy', () => {    const pool = new ChatSessionPool({
      agentPresets: presets,
      agentBindings: new AgentBindingStore(join(dir, 'agent-bindings.json')),
      validatePresetBackend: () => ({ available: true }),
    });
    const first = pool.getOrCreateChatAgent('chat', callbacks());
    expect(first).toBeDefined();
    (first as unknown as { isBusy: boolean }).isBusy = true;
    expect(pool.setAgentBinding('chat', 'bound', 'admin')).toMatchObject({ ok: false });
    expect(pool.getAgentBinding('chat')).toBeUndefined();
    (first as unknown as { isBusy: boolean }).isBusy = false;
    expect(pool.setAgentBinding('chat', 'bound', 'admin')).toMatchObject({ ok: true });
    expect(first.dispose).toHaveBeenCalled();
    pool.getOrCreateChatAgent('chat', callbacks());
    expect(vi.mocked(AgentFactory.createChatAgent).mock.calls.at(-1)![3]).toMatchObject({ model: 'gpt-6.1-sol' });
    pool.disposeAll();
  });

  it('rejects a corrupt persisted document instead of silently dropping bindings', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-bindings.json'), '{"version":1,"bindings":{"chat":{"presetName":""}}}', { mode: 0o600 });
    expect(() => new AgentBindingStore(join(dir, 'agent-bindings.json'))).toThrow(/Invalid agent bindings/);
  });
});
