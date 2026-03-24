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
  buildProjectContextGuidance,
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

describe('buildProjectContextGuidance', () => {
  it('should include project context (CLAUDE.md) guidance section', () => {
    const result = buildProjectContextGuidance();
    expect(result).toContain('Project Context (CLAUDE.md)');
  });

  it('should instruct agent to check for CLAUDE.md after finding the project', () => {
    const result = buildProjectContextGuidance();
    expect(result).toContain('finding, cloning, or downloading');
    expect(result).toContain('project\'s root directory');
  });

  it('should specify the correct source: project directory, not workspace root', () => {
    const result = buildProjectContextGuidance();
    expect(result).toContain('not the workspace root');
  });

  it('should include the three-step workflow', () => {
    const result = buildProjectContextGuidance();
    expect(result).toContain('Step 1: Identify the Development Project');
    expect(result).toContain('Step 2: Check for CLAUDE.md');
    expect(result).toContain('Step 3: Read and Apply');
  });

  it('should describe what CLAUDE.md may contain', () => {
    const result = buildProjectContextGuidance();
    expect(result).toContain('Project structure and architecture');
    expect(result).toContain('Coding conventions');
    expect(result).toContain('Build, test, and lint commands');
  });

  it('should handle the case when CLAUDE.md does not exist', () => {
    const result = buildProjectContextGuidance();
    expect(result).toContain('does **not** exist');
    expect(result).toContain('general best practices');
  });

  it('should emphasize correct timing (after finding project, not at startup)', () => {
    const result = buildProjectContextGuidance();
    expect(result).toContain('**after** finding/downloading the project');
    expect(result).toContain('not at the start of the conversation');
  });
});
