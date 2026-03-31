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
  buildProjectContextSection,
  buildProjectContextAwarenessGuidance,
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

describe('buildProjectContextSection', () => {
  it('should return empty string when no context is provided', () => {
    expect(buildProjectContextSection()).toBe('');
    expect(buildProjectContextSection(undefined)).toBe('');
  });

  it('should return formatted section when context is provided', () => {
    const result = buildProjectContextSection('# Project Rules\n- Use TypeScript\n- Follow ESLint');
    expect(result).toContain('Project Context (CLAUDE.md)');
    expect(result).toContain('# Project Rules');
    expect(result).toContain('- Use TypeScript');
    expect(result).toContain('- Follow ESLint');
  });

  it('should instruct the agent to follow project conventions', () => {
    const result = buildProjectContextSection('Some conventions');
    expect(result).toContain('MUST follow these conventions');
  });

  it('should include source reference to CLAUDE.md', () => {
    const result = buildProjectContextSection('content');
    expect(result).toContain("project's CLAUDE.md file");
  });

  it('should truncate extremely large context (>32KB)', () => {
    const largeContent = 'x'.repeat(33 * 1024); // 33KB
    const result = buildProjectContextSection(largeContent);
    expect(result).toContain('truncated');
    expect(result.length).toBeLessThan(largeContent.length + 200);
  });

  it('should not truncate content within 32KB limit', () => {
    const content = 'Valid project context content';
    const result = buildProjectContextSection(content);
    expect(result).not.toContain('truncated');
    expect(result).toContain(content);
  });
});

describe('buildProjectContextAwarenessGuidance', () => {
  it('should include project context awareness section', () => {
    const result = buildProjectContextAwarenessGuidance();
    expect(result).toContain('Project Context Awareness');
  });

  it('should instruct the agent to check for CLAUDE.md', () => {
    const result = buildProjectContextAwarenessGuidance();
    expect(result).toContain('CLAUDE.md');
    expect(result).toContain('check for');
  });

  it('should describe when to check (development tasks)', () => {
    const result = buildProjectContextAwarenessGuidance();
    expect(result).toContain('development task');
    expect(result).toContain('development work');
  });

  it('should describe what to learn from CLAUDE.md', () => {
    const result = buildProjectContextAwarenessGuidance();
    expect(result).toContain('Coding conventions');
    expect(result).toContain('style guidelines');
    expect(result).toContain('architecture');
  });

  it('should describe fallback when CLAUDE.md is not found', () => {
    const result = buildProjectContextAwarenessGuidance();
    expect(result).toContain('If not found');
    expect(result).toContain('standard best practices');
  });

  it('should include examples of wrong and correct approaches', () => {
    const result = buildProjectContextAwarenessGuidance();
    expect(result).toContain('❌ Wrong Approach');
    expect(result).toContain('✅ Correct Approach');
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
