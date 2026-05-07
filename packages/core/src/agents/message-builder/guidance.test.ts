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
  buildTaskRecordGuidance,
  buildLocationAwarenessGuidance,
  buildRuntimeEnvAwarenessGuidance,
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

describe('buildTaskRecordGuidance', () => {
  it('should include task recording section header', () => {
    const result = buildTaskRecordGuidance();
    expect(result).toContain('Task Execution Recording');
  });

  it('should specify storage location', () => {
    const result = buildTaskRecordGuidance();
    expect(result).toContain('.claude/task-records.md');
  });

  it('should include record format with required fields', () => {
    const result = buildTaskRecordGuidance();
    expect(result).toContain('**Type**');
    expect(result).toContain('**Estimated Time**');
    expect(result).toContain('**Estimation Basis**');
    expect(result).toContain('**Actual Time**');
    expect(result).toContain('**Review**');
  });

  it('should include example entries', () => {
    const result = buildTaskRecordGuidance();
    expect(result).toContain('YYYY-MM-DD');
    expect(result).toContain('bugfix');
    expect(result).toContain('feature');
  });

  it('should include guidance on when to record', () => {
    const result = buildTaskRecordGuidance();
    expect(result).toContain('significant task');
    expect(result).toContain('feature');
    expect(result).toContain('bug fix');
  });

  it('should instruct agent to read existing records before estimating', () => {
    const result = buildTaskRecordGuidance();
    expect(result).toContain('Read existing records before estimating');
  });

  it('should mention creating file if not exists', () => {
    const result = buildTaskRecordGuidance();
    expect(result).toContain('Create the file if it does not exist');
  });
});

describe('buildRuntimeEnvAwarenessGuidance', () => {
  it('should include runtime-env awareness section header', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('Runtime Environment Variables');
  });

  it('should explain the runtime-env file mechanism', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('.runtime-env');
    expect(result).toContain('shared runtime environment variables');
  });

  it('should list common variables with their purposes', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('GH_TOKEN');
    expect(result).toContain('GH_TOKEN_EXPIRES_AT');
  });

  it('should explain how to access variables', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('process.env');
  });

  it('should include security warning about not exposing tokens', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('Never echo token values');
  });

  it('should mention token expiry checking', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('GH_TOKEN_EXPIRES_AT');
    expect(result).toContain('expired');
    expect(result).toContain('refreshed');
  });

  it('should explain shared nature of runtime-env', () => {
    const result = buildRuntimeEnvAwarenessGuidance();
    expect(result).toContain('shared across all agents');
  });
});
