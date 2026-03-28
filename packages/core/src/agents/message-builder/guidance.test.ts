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
  buildRuntimeEnvAwarenessGuidance,
  buildLocationAwarenessGuidance,
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

describe('buildRuntimeEnvAwarenessGuidance', () => {
  it('should include runtime environment sharing section header', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('Runtime Environment Sharing');
  });

  it('should mention the .runtime-env file', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('.runtime-env');
  });

  it('should explain auto-loading mechanism', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('Auto-loaded');
    expect(result).toContain('process.env');
  });

  it('should explain read/write operations', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('Read tool');
    expect(result).toContain('Write tool');
  });

  it('should mention GH_TOKEN as a common variable', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('GH_TOKEN');
    expect(result).toContain('GitHub');
  });

  it('should mention GH_TOKEN_EXPIRES_AT', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('GH_TOKEN_EXPIRES_AT');
  });

  it('should include KEY=VALUE format explanation', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('KEY=VALUE');
  });

  it('should warn against hardcoding secrets', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('hardcode');
  });

  it('should advise preserving existing variables when writing', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('preserve');
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
