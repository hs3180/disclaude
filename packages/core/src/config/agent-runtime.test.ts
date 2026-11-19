import { describe, expect, it } from 'vitest';
import { resolveDefaultAgentRuntime } from './agent-runtime.js';
import type { AgentPreset } from './types.js';

const claude: AgentPreset = { agentBackend: 'claude', model: 'claude-sonnet', apiKey: 'sk-test', llm: 'direct' };
const codex: AgentPreset = { agentBackend: 'codex', model: 'gpt-5.6', apiKey: 'sk-test', llm: 'direct' };

describe('resolveDefaultAgentRuntime', () => {
  it('prefers the defaultHarness entry when it is defined', () => {
    expect(
      resolveDefaultAgentRuntime({ claude, codex }, 'codex')
    ).toEqual({ ok: true, name: 'codex', preset: codex });
  });

  it('trims the defaultHarness reference before lookup', () => {
    expect(
      resolveDefaultAgentRuntime({ claude }, ' claude ')
    ).toEqual({ ok: true, name: 'claude', preset: claude });
  });

  it('rejects a defaultHarness that names no agents entry', () => {
    expect(resolveDefaultAgentRuntime({ claude }, 'codex')).toEqual({
      ok: false,
      error: 'defaultHarness must reference a defined agents entry: codex',
    });
  });

  it('falls back to the sole entry without a defaultHarness', () => {
    expect(resolveDefaultAgentRuntime({ claude }, undefined)).toEqual({
      ok: true,
      name: 'claude',
      preset: claude,
    });
  });

  it('prefers the reserved default key over declaration order', () => {
    expect(
      resolveDefaultAgentRuntime({ claude, default: codex }, undefined)
    ).toEqual({ ok: true, name: 'default', preset: codex });
  });

  it('prefers a default: true marker over declaration order', () => {
    expect(
      resolveDefaultAgentRuntime({ claude, codex: { ...codex, default: true } }, undefined)
    ).toEqual({ ok: true, name: 'codex', preset: { ...codex, default: true } });
  });

  it('uses declaration order when no default marker exists', () => {
    expect(
      resolveDefaultAgentRuntime({ claude, codex }, undefined)
    ).toEqual({ ok: true, name: 'claude', preset: claude });
  });

  it('rejects an empty agents map', () => {
    expect(resolveDefaultAgentRuntime({}, undefined)).toEqual({
      ok: false,
      error: 'agents must contain at least one named preset',
    });
  });

  it.each(['0', '4294967294'])('rejects numeric agents key %s', (name) => {
    expect(
      resolveDefaultAgentRuntime({ [name]: claude }, undefined)
    ).toMatchObject({ ok: false, error: expect.stringContaining('must not be numeric') });
  });

  it('rejects multiple default markers', () => {
    expect(
      resolveDefaultAgentRuntime(
        { default: claude, codex: { ...codex, default: true } },
        undefined
      )
    ).toEqual({
      ok: false,
      error: 'Unable to resolve default agent preset (found 2)',
    });
  });
});
