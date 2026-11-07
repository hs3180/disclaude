import { describe, expect, it, vi } from 'vitest';
import type { AgentPreset } from '@disclaude/core';

const native = vi.hoisted(() => ({
  getProvider: vi.fn(),
  getInfo: vi.fn(() => ({ available: true })),
  forgetSession: vi.fn(),
}));
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    getProvider: native.getProvider,
    Config: class extends actual.Config {
      static getAgentPresets() {
        return undefined;
      }
    },
  };
});
vi.mock('./agents/factory.js', () => ({
  AgentFactory: { resolveConfig: (options: unknown) => options },
}));

import { ChatSessionPool } from './chat-session-pool.js';

describe('named DSH pool routing', () => {
  it('uses the selected DSH connection for both switch preflight and reset', () => {
    const selected: AgentPreset = {
      agentBackend: 'dsh',
      llm: 'glm-native',
      model: 'glm-5.3',
      apiKey: '',
      mode: 'minimal',
      dshHome: '/selected-home',
      apiProtocol: 'openai',
      apiBaseUrl: 'https://dsh.example/v1',
    };
    native.getProvider.mockImplementation((_backend, settings) => {
      if (settings !== selected) {
        throw new Error('Default DSH settings were used');
      }
      return { getInfo: native.getInfo, forgetSession: native.forgetSession };
    });
    const pool = new ChatSessionPool({
      agentPresets: {
        codex: {
          agentBackend: 'codex',
          llm: 'daily',
          model: 'gpt-6-luna',
          apiKey: '',
          default: true,
        },
        dsh: selected,
      },
    });
    expect(pool.switchAgentPreset('test-chat', 'dsh')).toMatchObject({ ok: true });
    expect(native.getInfo).toHaveBeenCalledWith(expect.objectContaining({ settings: selected }));
    pool.reset('test-chat');
    expect(native.forgetSession).toHaveBeenCalledWith('test-chat');
    expect(native.getProvider).toHaveBeenLastCalledWith('dsh', selected);
  });

  it('switches a chat onto a DSH preset that shares its binding with Claude (Issue #5679)', () => {
    const shared = 'group/hq-degrade';
    const worker: AgentPreset = {
      agentBackend: 'dsh',
      llm: 'shared',
      model: shared,
      apiKey: 'shared-key',
      mode: 'minimal',
      apiProtocol: 'anthropic',
      apiBaseUrl: 'https://gateway.example',
    };
    const seen: Array<{ backend?: string; model?: string }> = [];
    native.getProvider.mockImplementation((backend, settings) => {
      seen.push({ backend, model: settings?.model });
      return { getInfo: native.getInfo, forgetSession: native.forgetSession };
    });
    const pool = new ChatSessionPool({
      agentPresets: {
        assistant: {
          agentBackend: 'claude',
          llm: 'shared',
          model: shared,
          apiKey: 'shared-key',
          default: true,
          apiProtocol: 'anthropic',
          apiBaseUrl: 'https://gateway.example',
        },
        worker,
      },
    });
    // The switch preflight validates the shared binding's DSH shape before
    // any session is replaced; both presets carry the same wire model.
    expect(pool.switchAgentPreset('test-chat', 'worker')).toMatchObject({
      ok: true,
      active: { model: shared, agentBackend: 'dsh' },
    });
    expect(seen.at(-1)).toEqual({ backend: 'dsh', model: shared });
    expect(pool.getActiveAgentPreset('test-chat')).toMatchObject({ model: shared });
  });
});
