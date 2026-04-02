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
  buildResearchModeGuidance,
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

describe('buildResearchModeGuidance', () => {
  it('should include Research Mode header', () => {
    const result = buildResearchModeGuidance({ topic: 'test', cwd: '/tmp/research' });
    expect(result).toContain('Research Mode');
  });

  it('should include the research topic when provided', () => {
    const result = buildResearchModeGuidance({ topic: 'AI safety', cwd: '/tmp/research' });
    expect(result).toContain('AI safety');
  });

  it('should include the working directory', () => {
    const result = buildResearchModeGuidance({ topic: 'test', cwd: '/workspace/research/ai' });
    expect(result).toContain('/workspace/research/ai');
  });

  it('should include research behavior rules when no soul content', () => {
    const result = buildResearchModeGuidance({ topic: 'test', cwd: '/tmp' });
    expect(result).toContain('Research Behavior Rules');
    expect(result).toContain('Focus on Research');
    expect(result).toContain('Source Citation');
  });

  it('should use custom SOUL content when provided', () => {
    const customSoul = '## Custom Rules\nBe thorough and precise.';
    const result = buildResearchModeGuidance({ topic: 'test', cwd: '/tmp', soulContent: customSoul });
    expect(result).toContain('Custom Rules');
    expect(result).toContain('Be thorough and precise.');
    expect(result).not.toContain('Research Behavior Rules');
  });

  it('should include mode switch commands', () => {
    const result = buildResearchModeGuidance({ topic: 'test', cwd: '/tmp' });
    expect(result).toContain('/mode normal');
    expect(result).toContain('/research');
  });

  it('should handle missing topic gracefully', () => {
    const result = buildResearchModeGuidance({ cwd: '/tmp' });
    expect(result).toContain('Research Mode');
    expect(result).toContain('No specific topic set');
  });

  it('should handle all empty options', () => {
    const result = buildResearchModeGuidance({});
    expect(result).toContain('Research Mode');
    expect(result).toContain('default');
  });
});
