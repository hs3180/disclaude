import { describe, expect, it } from 'vitest';
import { resolveCodexModelSetting, resolveCodexReasoningEffort } from './codex-settings.js';

describe('native Codex settings', () => {
  it('uses the bound LLM unless the host explicitly overrides it', () => {
    expect(resolveCodexModelSetting({ configured: 'gpt-6-luna' })).toEqual({
      value: 'gpt-6-luna',
      source: 'llms.model',
    });
    expect(
      resolveCodexModelSetting({ configured: 'gpt-6-luna', environment: 'gpt-5.6-luna' })
    ).toEqual({ value: 'gpt-5.6-luna', source: 'environment' });
    expect(resolveCodexModelSetting({})).toEqual({ source: 'codex-cli-default' });
  });
  it('defers unset effort to the CLI and honors explicit overrides', () => {
    expect(resolveCodexReasoningEffort({})).toEqual({ source: 'codex-cli-model-default' });
    expect(resolveCodexReasoningEffort({ configured: 'max' })).toEqual({
      value: 'max',
      source: 'agents.codex.reasoningEffort',
    });
    expect(resolveCodexReasoningEffort({ configured: 'max', environment: 'low' })).toEqual({
      value: 'low',
      source: 'environment',
    });
  });
});
