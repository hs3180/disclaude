/**
 * Issue #5718: capability-absent runtime — the installed
 * @earendil-works/pi-agent-core predates the native skills channel verified
 * in 0.83.0 (loadSkills + formatSkillsForSystemPrompt on the index export,
 * NodeExecutionEnv on the `/node` subentry).
 *
 * This file mocks the package with ONLY `{ Agent }` — the exact export shape
 * of the pre-0.83.0 runtime disclaude's mirrors were verified against
 * (pi-runtime.ts header) — and deliberately does NOT mock the `/node`
 * subentry, so its real import rejects (the package is not a workspace
 * dependency) and the loader leaves the channel absent. The companion
 * provider.querystream.test.ts covers the channel-present runtime.
 *
 * Contract under test: with an explicitly installed skill source and no
 * native channel, the provider fails fast with the shared actionable
 * diagnostic (evidence + remedy + no-manifest/no-turn statement) instead of
 * silently falling back to a Disclaude-authored manifest — while clean
 * Projects on the same runtime run unchanged (the explicit-install boundary).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { manageDiagnosticsPlugin } from '../../../skills/diagnostics-plugin.js';

const { fakeState } = vi.hoisted(() => ({
  fakeState: {
    ctorOptions: null as unknown,
    prompts: [] as unknown[],
  },
}));

class FakeAgent {
  private listeners: Array<(event: Record<string, unknown>) => Promise<void> | void> = [];
  constructor(options: unknown) {
    fakeState.ctorOptions = options;
  }
  subscribe(listener: (event: Record<string, unknown>) => Promise<void> | void): () => void {
    this.listeners.push(listener);
    return () => undefined;
  }
  async prompt(message: unknown): Promise<void> {
    fakeState.prompts.push(message);
    for (const listener of [...this.listeners]) {
      await listener({ type: 'agent_end', messages: [] });
    }
  }
  followUp(): Promise<void> {
    return Promise.resolve();
  }
  abort(): void {}
  async waitForIdle(): Promise<void> {}
}

// Export shape of the pre-0.83.0 runtime: only `Agent`. The skills exports
// are declared as undefined explicitly — a real ESM namespace returns
// undefined for absent exports (what the probe reads), while vitest's mock
// proxy THROWS on access of an undeclared export.
vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: FakeAgent,
  loadSkills: undefined,
  formatSkillsForSystemPrompt: undefined,
}));

import { PiAgentProvider } from './provider.js';
import { resetPiRuntimeCache } from './pi-runtime.js';
import type { AgentMessage, AgentQueryOptions, UserInput } from '../../types.js';

async function* inputs(...values: UserInput[]): AsyncGenerator<UserInput> {
  for (const value of values) {
    yield value;
  }
}

function userInput(text: string): UserInput {
  return { role: 'user', content: text };
}

async function collect(iterator: AsyncGenerator<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const message of iterator) {
    out.push(message);
  }
  return out;
}

const baseOptions = (): AgentQueryOptions & { systemPrompt?: string } =>
  ({ settingSources: [] }) as AgentQueryOptions & { systemPrompt?: string };

describe('PiAgentProvider skills channel capability probe (Issue #5718)', () => {
  let provider: PiAgentProvider;

  beforeEach(() => {
    resetPiRuntimeCache();
    fakeState.ctorOptions = null;
    fakeState.prompts = [];
    provider = new PiAgentProvider();
    provider.streamFn = (): unknown => ({});
  });

  it('fails fast with the shared actionable diagnostic when the runtime predates the channel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-capability-'));
    try {
      const project = join(root, 'project');
      mkdirSync(project);
      manageDiagnosticsPlugin('install', project, resolve('.'));
      await expect(
        collect(
          provider.queryStream(inputs(userInput('hi')), { ...baseOptions(), cwd: project }).iterator
        )
      ).rejects.toThrow(
        /Pi \(@earendil-works\/pi-agent-core\) cannot natively load Disclaude-managed skills: .*native skills API.*verified present in 0\.83\.0.*Upgrade @earendil-works\/pi-agent-core to >=0\.83\.0.*plugins remove diagnostics.*No prompt manifest was injected and no model turn was submitted/s
      );
      // Fail-fast means fail-BEFORE the agent: nothing was constructed and no
      // model turn was submitted on the dirty project.
      expect(fakeState.ctorOptions).toBeNull();
      expect(fakeState.prompts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps clean Projects running unchanged on the same capability-absent runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-capability-clean-'));
    try {
      const project = join(root, 'project');
      mkdirSync(project);
      // No installation → no probe, no failure: the explicit-install boundary.
      const messages = await collect(
        provider.queryStream(inputs(userInput('hi')), {
          ...baseOptions(),
          cwd: project,
          systemPrompt: 'ordinary',
        }).iterator
      );
      expect(fakeState.ctorOptions).toMatchObject({ initialState: { systemPrompt: 'ordinary' } });
      expect(messages.map((message) => message.type)).toContain('result');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
