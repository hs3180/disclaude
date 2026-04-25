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
  buildDiscussionFocusGuidance,
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

describe('buildDiscussionFocusGuidance', () => {
  it('should return empty string when no topic is provided', () => {
    expect(buildDiscussionFocusGuidance()).toBe('');
    expect(buildDiscussionFocusGuidance(undefined)).toBe('');
    expect(buildDiscussionFocusGuidance('')).toBe('');
  });

  it('should include discussion focus mode header', () => {
    const result = buildDiscussionFocusGuidance('Should we automate code formatting?');
    expect(result).toContain('Discussion Focus Mode');
    expect(result).toContain('focused discussion');
  });

  it('should include the original discussion topic', () => {
    const result = buildDiscussionFocusGuidance('Should we automate code formatting?');
    expect(result).toContain('Should we automate code formatting?');
    expect(result).toContain('Original Discussion Topic');
  });

  it('should include core principles for focused discussion', () => {
    const result = buildDiscussionFocusGuidance('Some topic');
    expect(result).toContain('Stay on topic');
    expect(result).toContain('north star');
    expect(result).toContain('Gently redirect when needed');
    expect(result).toContain('Depth over breadth');
  });

  it('should include redirect example', () => {
    const result = buildDiscussionFocusGuidance('Some topic');
    expect(result).toContain('let\'s not lose sight of our original question');
  });

  it('should include boundary guidelines', () => {
    const result = buildDiscussionFocusGuidance('Some topic');
    expect(result).toContain('Do not chase every interesting tangent');
    expect(result).toContain('note it and move back to the core topic');
  });

  it('should include conclusion guidance', () => {
    const result = buildDiscussionFocusGuidance('Some topic');
    expect(result).toContain('When the Discussion Reaches Conclusion');
    expect(result).toContain('Summarize the key insights');
  });

  it('should handle topics with special characters', () => {
    const result = buildDiscussionFocusGuidance('Should we use `eslint` & `prettier` together? (2026)');
    expect(result).toContain('eslint');
    expect(result).toContain('prettier');
  });

  it('should handle long multi-line topics', () => {
    const topic = 'How should we handle the migration from the old API to the new one?\nConsider: backwards compatibility, performance, and team bandwidth.';
    const result = buildDiscussionFocusGuidance(topic);
    expect(result).toContain('migration from the old API');
    expect(result).toContain('backwards compatibility');
  });

  it('should produce consistently formatted output for different topics', () => {
    const result1 = buildDiscussionFocusGuidance('Topic A');
    const result2 = buildDiscussionFocusGuidance('Topic B');

    // Both should have the same structure, just different topics
    const structure1 = result1.replace('Topic A', '__TOPIC__');
    const structure2 = result2.replace('Topic B', '__TOPIC__');
    expect(structure1).toBe(structure2);
  });
});
