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
  it('should return empty string when no vars are provided', () => {
    expect(buildRuntimeEnvGuidance()).toBe('');
    expect(buildRuntimeEnvGuidance(undefined)).toBe('');
    expect(buildRuntimeEnvGuidance({})).toBe('');
  });

  it('should include runtime env section header', () => {
    const result = buildRuntimeEnvGuidance({ GH_TOKEN: 'ghs_xxx' });
    expect(result).toContain('Runtime Environment Variables');
    expect(result).toContain('shared across agents and tools');
  });

  it('should list variable names without exposing values', () => {
    const result = buildRuntimeEnvGuidance({
      GH_TOKEN: 'ghs_super_secret_value',
      GH_TOKEN_EXPIRES_AT: '2026-03-20T12:00:00Z',
    });
    expect(result).toContain('**GH_TOKEN**');
    expect(result).toContain('**GH_TOKEN_EXPIRES_AT**');
    expect(result).not.toContain('ghs_super_secret_value');
    expect(result).not.toContain('2026-03-20T12:00:00Z');
  });

  it('should provide descriptions for known variables', () => {
    const result = buildRuntimeEnvGuidance({ GH_TOKEN: 'val' });
    expect(result).toContain('GitHub App Installation Access Token');
    expect(result).toContain('auto-refreshed');
  });

  it('should show generic description for unknown variables', () => {
    const result = buildRuntimeEnvGuidance({ CUSTOM_VAR: 'val' });
    expect(result).toContain('**CUSTOM_VAR**');
    expect(result).toContain('Runtime environment variable');
  });

  it('should include usage guidance for GitHub operations', () => {
    const result = buildRuntimeEnvGuidance({ GH_TOKEN: 'val' });
    expect(result).toContain('gh');
    expect(result).toContain('GH_TOKEN_EXPIRES_AT');
    expect(result).toContain('github-jwt-auth');
  });

  it('should handle mix of known and unknown variables', () => {
    const result = buildRuntimeEnvGuidance({
      GH_TOKEN: 'val',
      CUSTOM_KEY: 'val2',
    });
    expect(result).toContain('**GH_TOKEN**');
    expect(result).toContain('GitHub App Installation Access Token');
    expect(result).toContain('**CUSTOM_KEY**');
    expect(result).toContain('Runtime environment variable');
  });
});
