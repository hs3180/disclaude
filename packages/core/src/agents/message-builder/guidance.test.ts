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

describe('buildResearchModeGuidance', () => {
  it('should return empty string when no mode state is provided', () => {
    expect(buildResearchModeGuidance()).toBe('');
    expect(buildResearchModeGuidance(undefined)).toBe('');
    expect(buildResearchModeGuidance(null)).toBe('');
  });

  it('should return empty string when mode is normal', () => {
    const result = buildResearchModeGuidance({ mode: 'normal' });
    expect(result).toBe('');
  });

  it('should return empty string when mode is research but no research config', () => {
    const result = buildResearchModeGuidance({ mode: 'research' });
    expect(result).toBe('');
  });

  it('should include research mode section when in research mode', () => {
    const result = buildResearchModeGuidance({
      mode: 'research',
      research: {
        topic: 'machine-learning',
        cwd: '/app/workspace/workspace/research/machine-learning',
        activatedAt: '2026-04-05T00:00:00.000Z',
      },
    });
    expect(result).toContain('Research Mode');
    expect(result).toContain('machine-learning');
  });

  it('should include working directory path', () => {
    const result = buildResearchModeGuidance({
      mode: 'research',
      research: {
        topic: 'test',
        cwd: '/app/workspace/workspace/research/test',
        activatedAt: '2026-04-05T00:00:00.000Z',
      },
    });
    expect(result).toContain('/app/workspace/workspace/research/test');
  });

  it('should include research guidelines', () => {
    const result = buildResearchModeGuidance({
      mode: 'research',
      research: {
        topic: 'test',
        cwd: '/test/cwd',
        activatedAt: '2026-04-05T00:00:00.000Z',
      },
    });
    expect(result).toContain('Research Guidelines');
    expect(result).toContain('thoroughness and accuracy');
    expect(result).toContain('Cite sources');
  });

  it('should include activation timestamp', () => {
    const result = buildResearchModeGuidance({
      mode: 'research',
      research: {
        topic: 'test',
        cwd: '/test/cwd',
        activatedAt: '2026-04-05T12:00:00.000Z',
      },
    });
    expect(result).toContain('2026-04-05T12:00:00.000Z');
  });

  it('should include directory access restriction', () => {
    const result = buildResearchModeGuidance({
      mode: 'research',
      research: {
        topic: 'test',
        cwd: '/test/cwd',
        activatedAt: '2026-04-05T00:00:00.000Z',
      },
    });
    expect(result).toContain('Only access files within this directory');
    expect(result).toContain('Do not access other project files');
  });
});
