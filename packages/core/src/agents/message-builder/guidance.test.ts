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
  buildChatIdPersistenceGuidance,
  buildWorkingDirectoryGuidance,
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

describe('buildChatIdPersistenceGuidance', () => {
  it('should include DISCLAUDE_CHAT_ID environment variable reference', () => {
    const result = buildChatIdPersistenceGuidance();
    expect(result).toContain('DISCLAUDE_CHAT_ID');
    expect(result).toContain('Chat ID Persistence');
  });

  it('should instruct agent to use env var over conversation history', () => {
    const result = buildChatIdPersistenceGuidance();
    expect(result).toContain('environment variable');
    expect(result).toContain('Context compaction');
    expect(result).toContain('send_*');
  });

  it('should include the echo command for retrieving chatId', () => {
    const result = buildChatIdPersistenceGuidance();
    expect(result).toContain('echo $DISCLAUDE_CHAT_ID');
  });

  it('should warn about stale chatIds from compacted summaries', () => {
    const result = buildChatIdPersistenceGuidance();
    expect(result).toContain('stale');
    expect(result).toContain('compacted');
  });
});

describe('buildWorkingDirectoryGuidance', () => {
  it('should include working directory warning', () => {
    const result = buildWorkingDirectoryGuidance();
    expect(result).toContain('Working Directory');
    expect(result).toContain('NOT a git repository');
  });

  it('should include git rev-parse check command', () => {
    const result = buildWorkingDirectoryGuidance();
    expect(result).toContain('git rev-parse --show-toplevel');
  });

  it('should instruct agent to navigate before running git/gh commands', () => {
    const result = buildWorkingDirectoryGuidance();
    expect(result).toContain('git');
    expect(result).toContain('gh');
    expect(result).toContain('cd');
  });
});
