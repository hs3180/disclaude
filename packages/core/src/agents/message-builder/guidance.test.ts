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
  buildProgressReportingGuidance,
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

describe('buildProgressReportingGuidance', () => {
  it('should return a non-empty string', () => {
    const result = buildProgressReportingGuidance();
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(100);
  });

  it('should contain progress reporting section header', () => {
    const result = buildProgressReportingGuidance();
    expect(result).toContain('Progress Reporting for Long Tasks');
    expect(result).toContain('Issue #857');
  });

  it('should mention the get_task_status tool', () => {
    const result = buildProgressReportingGuidance();
    expect(result).toContain('get_task_status');
  });

  it('should include the progress card template', () => {
    const result = buildProgressReportingGuidance();
    expect(result).toContain('任务执行中');
    expect(result).toContain('send_card');
  });

  it('should emphasize agent-driven decisions', () => {
    const result = buildProgressReportingGuidance();
    expect(result).toContain('You decide when to report');
    expect(result).toContain('no fixed intervals');
  });

  it('should include reporting principles', () => {
    const result = buildProgressReportingGuidance();
    expect(result).toContain('Be helpful, not noisy');
    expect(result).toContain('Report failures promptly');
    expect(result).toContain('Report completion');
  });
});
