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
  buildTasteGuidance,
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

describe('buildTasteGuidance', () => {
  it('should return empty string when no groups provided', () => {
    expect(buildTasteGuidance()).toBe('');
    expect(buildTasteGuidance(undefined)).toBe('');
    expect(buildTasteGuidance([])).toBe('');
  });

  it('should include taste preferences header', () => {
    const result = buildTasteGuidance([
      { category: 'code_style', rules: [{ id: '1', content: '使用 const/let', category: 'code_style', source: 'manual', createdAt: '2026-04-01T00:00:00Z' }] },
    ]);
    expect(result).toContain('User Taste Preferences');
    expect(result).toContain('Always follow these');
  });

  it('should display category name in Chinese for known categories', () => {
    const result = buildTasteGuidance([
      { category: 'code_style', rules: [{ id: '1', content: '使用 const/let', category: 'code_style', source: 'manual', createdAt: '2026-04-01T00:00:00Z' }] },
    ]);
    expect(result).toContain('代码风格');
  });

  it('should display raw category name for unknown categories', () => {
    const result = buildTasteGuidance([
      { category: 'custom_cat', rules: [{ id: '1', content: 'some rule', category: 'custom_cat', source: 'manual', createdAt: '2026-04-01T00:00:00Z' }] },
    ]);
    expect(result).toContain('custom_cat');
  });

  it('should include correction count for auto-detected rules', () => {
    const result = buildTasteGuidance([
      { category: 'code_style', rules: [{ id: '1', content: '使用 const/let', category: 'code_style', source: 'auto_detected', count: 3, createdAt: '2026-04-01T00:00:00Z' }] },
    ]);
    expect(result).toContain('被纠正 3 次');
  });

  it('should include source label for CLAUDE.md rules', () => {
    const result = buildTasteGuidance([
      { category: 'other', rules: [{ id: '1', content: '使用中文', category: 'other', source: 'claude_md', createdAt: '2026-04-01T00:00:00Z' }] },
    ]);
    expect(result).toContain('来自 CLAUDE.md');
  });

  it('should not include source label for manual rules', () => {
    const result = buildTasteGuidance([
      { category: 'other', rules: [{ id: '1', content: '使用中文', category: 'other', source: 'manual', createdAt: '2026-04-01T00:00:00Z' }] },
    ]);
    expect(result).not.toContain('被纠正');
    expect(result).not.toContain('来自 CLAUDE.md');
  });

  it('should format multiple categories', () => {
    const result = buildTasteGuidance([
      { category: 'code_style', rules: [{ id: '1', content: '使用 const/let', category: 'code_style', source: 'manual', createdAt: '2026-04-01T00:00:00Z' }] },
      { category: 'interaction', rules: [{ id: '2', content: '回复简洁', category: 'interaction', source: 'auto_detected', count: 2, createdAt: '2026-04-01T00:00:00Z' }] },
    ]);
    expect(result).toContain('代码风格');
    expect(result).toContain('交互习惯');
    expect(result).toContain('使用 const/let');
    expect(result).toContain('回复简洁');
  });

  it('should include taste explanation note', () => {
    const result = buildTasteGuidance([
      { category: 'other', rules: [{ id: '1', content: 'some rule', category: 'other', source: 'manual', createdAt: '2026-04-01T00:00:00Z' }] },
    ]);
    expect(result).toContain('基于你的偏好');
  });
});
