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

describe('buildChatHistorySection - edge cases', () => {
  it('should return formatted section for whitespace-only input (truthy string)', () => {
    // The function checks falsy (!value), not trimmed whitespace
    const result = buildChatHistorySection('   ');
    expect(result).toContain('Recent Chat History');
    expect(result).toContain('   ');
  });

  it('should preserve special characters and formatting in context', () => {
    const context = 'User: <script>alert("xss")</script>\nAgent: Hello **bold** world';
    const result = buildChatHistorySection(context);
    expect(result).toContain('<script>alert("xss")</script>');
    expect(result).toContain('**bold**');
  });

  it('should handle very long context without truncation', () => {
    const longContext = 'A'.repeat(10000);
    const result = buildChatHistorySection(longContext);
    expect(result).toContain(longContext);
    expect(result.length).toBeGreaterThan(10000);
  });

  it('should handle context with markdown links and code blocks', () => {
    const context = '[link](https://example.com)\n```js\nconsole.log("test");\n```';
    const result = buildChatHistorySection(context);
    expect(result).toContain('[link](https://example.com)');
    expect(result).toContain('```js');
  });
});

describe('buildPersistedHistorySection - edge cases', () => {
  it('should return formatted section for whitespace-only input (truthy string)', () => {
    // The function checks falsy (!value), not trimmed whitespace
    const result = buildPersistedHistorySection('   ');
    expect(result).toContain('Previous Session Context');
    expect(result).toContain('   ');
  });

  it('should preserve multiline conversation history', () => {
    const history = 'Line 1\nLine 2\nLine 3\nLine 4';
    const result = buildPersistedHistorySection(history);
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 4');
  });
});

describe('buildNextStepGuidance - edge cases', () => {
  it('should use card template when supportsCards is explicitly true', () => {
    const result = buildNextStepGuidance(true);
    expect(result).toContain('actionPrompts');
    expect(result).toContain('interactive card');
    expect(result).toContain('chatId');
  });

  it('should include "wide_screen_mode" config in card template', () => {
    const result = buildNextStepGuidance(true);
    expect(result).toContain('wide_screen_mode');
  });

  it('should include button type specifications in card template', () => {
    const result = buildNextStepGuidance(true);
    expect(result).toContain('"type": "primary"');
  });
});

describe('buildOutputFormatGuidance - edge cases', () => {
  it('should include Markdown table guidance', () => {
    const result = buildOutputFormatGuidance();
    expect(result).toContain('Markdown tables instead of raw JSON');
  });

  it('should include emoji formatting guidance', () => {
    const result = buildOutputFormatGuidance();
    expect(result).toContain('emoji');
    expect(result).toContain('bold');
    expect(result).toContain('italic');
  });
});

describe('buildLocationAwarenessGuidance - edge cases', () => {
  it('should include numbered steps for handling location questions', () => {
    const result = buildLocationAwarenessGuidance();
    expect(result).toContain('1.');
    expect(result).toContain('2.');
    expect(result).toContain('3.');
  });

  it('should include locale settings as non-indicator', () => {
    const result = buildLocationAwarenessGuidance();
    expect(result).toContain('locale settings');
  });
});
