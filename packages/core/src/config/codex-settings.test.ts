import { describe, expect, it } from 'vitest';
import { resolveCodexModelSetting, resolveCodexReasoningEffort } from './codex-settings.js';

describe('Codex model and reasoning effort settings', () => {
  it('resolves one model source while retaining legacy settings as fallback', () => {
    expect(
      resolveCodexModelSetting({
        environment: ' gpt-5.6-luna ',
        configured: 'gpt-5.5',
        legacyAgent: 'gpt-5.4',
        legacyPreset: 'gpt-5.3',
      })
    ).toEqual({ value: 'gpt-5.6-luna', source: 'environment' });
    expect(
      resolveCodexModelSetting({
        configured: 'gpt-5.5',
        legacyAgent: 'gpt-5.4',
        legacyPreset: 'gpt-5.3',
      })
    ).toEqual({ value: 'gpt-5.5', source: 'agent.codex.model' });
    expect(
      resolveCodexModelSetting({
        legacyAgent: 'gpt-5.4',
        legacyPreset: 'gpt-5.3',
      })
    ).toEqual({ value: 'gpt-5.4', source: 'agent.model' });
    expect(resolveCodexModelSetting({ legacyPreset: 'gpt-5.3' })).toEqual({
      value: 'gpt-5.3',
      source: 'agents.default.model',
    });
    expect(resolveCodexModelSetting({})).toEqual({ source: 'codex-cli-default' });
  });

  it('keeps reasoning effort model-specific when no explicit value is configured', () => {
    expect(resolveCodexReasoningEffort({ environment: 'high', configured: 'low' })).toEqual({
      value: 'high',
      source: 'environment',
    });
    expect(resolveCodexReasoningEffort({ configured: 'xhigh' })).toEqual({
      value: 'xhigh',
      source: 'agent.codex.reasoningEffort',
    });
    expect(resolveCodexReasoningEffort({ configured: 'high', environment: 'unsupported' })).toEqual(
      { value: 'high', source: 'agent.codex.reasoningEffort' }
    );
    expect(resolveCodexReasoningEffort({})).toEqual({ source: 'codex-cli-model-default' });
  });
});
