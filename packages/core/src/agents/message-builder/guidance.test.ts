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
  buildProjectAwarenessGuidance,
  buildProjectContextGuidance,
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

describe('buildProjectAwarenessGuidance', () => {
  it('should include project context awareness section', () => {
    const result = buildProjectAwarenessGuidance();
    expect(result).toContain('Project Context Awareness');
    expect(result).toContain('CLAUDE.md');
  });

  it('should instruct to check for CLAUDE.md after cloning', () => {
    const result = buildProjectAwarenessGuidance();
    expect(result).toContain('clone');
    expect(result).toContain('download');
    expect(result).toContain('project root');
  });

  it('should mention following project conventions', () => {
    const result = buildProjectAwarenessGuidance();
    expect(result).toContain('Coding standards');
    expect(result).toContain('Build');
    expect(result).toContain('test');
    expect(result).toContain('commit message');
  });

  it('should include graceful fallback for missing CLAUDE.md', () => {
    const result = buildProjectAwarenessGuidance();
    expect(result).toContain('fallback');
    expect(result).toContain('general best practices');
  });

  it('should include example workflow', () => {
    const result = buildProjectAwarenessGuidance();
    expect(result).toContain('Example Workflow');
    expect(result).toContain('Clone the project');
    expect(result).toContain('Check');
  });
});

describe('buildProjectContextGuidance', () => {
  it('should return empty string when no content is provided', () => {
    expect(buildProjectContextGuidance('', '/some/path')).toBe('');
    expect(buildProjectContextGuidance('  ', '/some/path')).toBe('');
    expect(buildProjectContextGuidance(undefined as unknown as string, '/some/path')).toBe('');
  });

  it('should include the CLAUDE.md content in formatted section', () => {
    const content = '# My Project\n\nUse TypeScript strict mode.';
    const result = buildProjectContextGuidance(content, '/tmp/my-project');

    expect(result).toContain('Project Context');
    expect(result).toContain('/tmp/my-project');
    expect(result).toContain('Use TypeScript strict mode');
  });

  it('should include convention compliance instruction', () => {
    const result = buildProjectContextGuidance('# Some content', '/path');
    expect(result).toContain('Convention Compliance');
    expect(result).toContain('MUST comply');
  });

  it('should reference the source path', () => {
    const result = buildProjectContextGuidance('content', '/home/user/project');
    expect(result).toContain('/home/user/project');
  });
});
