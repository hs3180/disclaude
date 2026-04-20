/**
 * Tests for composable guidance builder functions.
 *
 * Issue #1492: Tests for framework-agnostic guidance functions
 * extracted from MessageBuilder.
 */

import { describe, it, expect } from 'vitest';
import {
  buildChatHistorySection,
  buildPersistedHistorySection,
  buildNextStepGuidance,
  buildOutputFormatGuidance,
  buildLocationAwarenessGuidance,
  buildRuntimeEnvGuidance,
} from './guidance.js';

describe('buildChatHistorySection', () => {
  it('should return empty string when no context is provided', () => {
    expect(buildChatHistorySection()).toBe('');
    expect(buildChatHistorySection(undefined)).toBe('');
  });

  it('should return formatted section when context is provided', () => {
    const result = buildChatHistorySection('User: Hello\nAgent: Hi there');
    expect(result).toContain('Recent Chat History');
    expect(result).toContain('User: Hello');
    expect(result).toContain('Agent: Hi there');
  });

  it('should include the @mentioned context note', () => {
    const result = buildChatHistorySection('some context');
    expect(result).toContain('@mentioned in a group chat');
  });

  it('should include empty-mention guidance to answer pending questions', () => {
    const result = buildChatHistorySection('User asked a question');
    expect(result).toContain('empty (only an @mention with no text)');
    expect(result).toContain('proactively answer it');
    expect(result).toContain('pending question');
  });

  it('should instruct agent not to ask what user needs on empty mention', () => {
    const result = buildChatHistorySection('context here');
    expect(result).toContain('Do not ask the user what they need');
  });
});

describe('buildPersistedHistorySection', () => {
  it('should return empty string when no context is provided', () => {
    expect(buildPersistedHistorySection()).toBe('');
    expect(buildPersistedHistorySection(undefined)).toBe('');
  });

  it('should return formatted section when context is provided', () => {
    const result = buildPersistedHistorySection('Previous conversation...');
    expect(result).toContain('Previous Session Context');
    expect(result).toContain('service was recently restarted');
    expect(result).toContain('Previous conversation...');
  });
});

describe('buildNextStepGuidance', () => {
  it('should include interactive card template when cards are supported', () => {
    const result = buildNextStepGuidance(true);
    expect(result).toContain('Next Steps After Response');
    expect(result).toContain('actionPrompts');
    expect(result).toContain('interactive card');
  });

  it('should include simple list fallback when cards are not supported', () => {
    const result = buildNextStepGuidance(false);
    expect(result).toContain('Next Steps After Response');
    expect(result).not.toContain('actionPrompts');
    expect(result).not.toContain('interactive card');
    expect(result).toContain('simple list');
  });

  it('should default to card template when supportsCards is undefined', () => {
    const result = buildNextStepGuidance(undefined);
    expect(result).toContain('actionPrompts');
    expect(result).toContain('interactive card');
  });
});

describe('buildOutputFormatGuidance', () => {
  it('should include output format requirements', () => {
    const result = buildOutputFormatGuidance();
    expect(result).toContain('Output Format Requirements');
    expect(result).toContain('Never output raw JSON');
  });

  it('should include correct and wrong format examples', () => {
    const result = buildOutputFormatGuidance();
    expect(result).toContain('✅ Correct Format');
    expect(result).toContain('❌ Wrong Format');
  });

  it('should include guidance for converting JSON to readable format', () => {
    const result = buildOutputFormatGuidance();
    expect(result).toContain('Convert JSON objects to readable text');
    expect(result).toContain('Markdown tables instead of raw JSON');
  });
});

describe('buildLocationAwarenessGuidance', () => {
  it('should include location awareness warning', () => {
    const result = buildLocationAwarenessGuidance();
    expect(result).toContain('Location Awareness');
    expect(result).toContain('do NOT know the user\'s physical location');
  });

  it('should include examples of wrong and correct approaches', () => {
    const result = buildLocationAwarenessGuidance();
    expect(result).toContain('❌ Wrong Approach');
    expect(result).toContain('✅ Correct Approach');
  });

  it('should mention not inferring from system information', () => {
    const result = buildLocationAwarenessGuidance();
    expect(result).toContain('timezone');
    expect(result).toContain('IP address');
    expect(result).toContain('Wi-Fi');
  });
});

describe('buildRuntimeEnvGuidance', () => {
  it('should return empty string when no runtime env vars are provided', () => {
    expect(buildRuntimeEnvGuidance()).toBe('');
    expect(buildRuntimeEnvGuidance(undefined)).toBe('');
  });

  it('should return empty string when empty object is provided', () => {
    expect(buildRuntimeEnvGuidance({})).toBe('');
  });

  it('should include Runtime Environment section heading', () => {
    const result = buildRuntimeEnvGuidance({ GH_TOKEN: 'ghs_abc123' });
    expect(result).toContain('Runtime Environment');
  });

  it('should list runtime env vars with keys and values', () => {
    const result = buildRuntimeEnvGuidance({ GH_TOKEN: 'ghs_abc123', SOME_VAR: 'hello' });
    expect(result).toContain('`GH_TOKEN`');
    expect(result).toContain('`SOME_VAR`');
    expect(result).toContain('hello');
  });

  it('should mask sensitive values (tokens, keys, secrets)', () => {
    const result = buildRuntimeEnvGuidance({ GH_TOKEN: 'ghs_abc123def456', AWS_SECRET_KEY: 'secret_value' });
    expect(result).toContain('...');
    expect(result).not.toContain('ghs_abc123def456');
    expect(result).not.toContain('secret_value');
    expect(result).toContain('chars)');
  });

  it('should show non-sensitive values in full', () => {
    const result = buildRuntimeEnvGuidance({ MODE: 'production', REGION: 'us-east-1' });
    expect(result).toContain('production');
    expect(result).toContain('us-east-1');
    expect(result).not.toContain('...');
  });

  it('should include descriptions for well-known variables', () => {
    const result = buildRuntimeEnvGuidance({ GH_TOKEN: 'ghs_xxx' });
    expect(result).toContain('GitHub personal access token');
  });

  it('should include usage notes about .runtime-env file', () => {
    const result = buildRuntimeEnvGuidance({ KEY: 'value' });
    expect(result).toContain('.runtime-env');
    expect(result).toContain('process.env');
  });
});
