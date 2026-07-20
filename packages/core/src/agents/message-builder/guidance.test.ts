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
  buildThreadContextSection,
  buildNextStepGuidance,
  buildOutputFormatGuidance,
  buildTaskRecordGuidance,
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

  it('should include coreference resolution guidance for ambiguous references', () => {
    const result = buildChatHistorySection('context here');
    expect(result).toContain('Coreference resolution');
    expect(result).toContain('do NOT guess');
    expect(result).toContain('clarify which one');
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

describe('buildThreadContextSection', () => {
  it('should return empty string when no context is provided', () => {
    expect(buildThreadContextSection()).toBe('');
    expect(buildThreadContextSection(undefined)).toBe('');
  });

  it('should return formatted section when thread context is provided', () => {
    const result = buildThreadContextSection('👤 Root message\n\n🤖 Bot reply');
    expect(result).toContain('Thread Context');
    expect(result).toContain('topic group thread');
    expect(result).toContain('👤 Root message');
    expect(result).toContain('🤖 Bot reply');
  });

  it('should mention conversation history from oldest to newest', () => {
    const result = buildThreadContextSection('some thread context');
    expect(result).toContain('oldest to newest');
  });

  it('should include coreference resolution guidance for ambiguous references', () => {
    const result = buildThreadContextSection('context here');
    expect(result).toContain('Coreference resolution');
    expect(result).toContain('do NOT guess');
    expect(result).toContain('clarify which one');
  });

  // Issue #4306: tell the agent how to fetch thread context / attachments on
  // demand via lark-cli (ancestor-message attachments are not auto-delivered).
  it('should include lark-cli on-demand thread context / attachment guidance', () => {
    const result = buildThreadContextSection('context here');
    expect(result).toContain('lark-cli');
    // List all thread messages + download attachments (recommended path).
    expect(result).toContain('+threads-messages-list');
    expect(result).toContain('--download-resources');
    // Fetch specific messages.
    expect(result).toContain('+messages-mget');
    // Download a single message's attachment.
    expect(result).toContain('+messages-resources-download');
    // --thread accepts any message id in the thread (auto-resolves to root).
    expect(result).toContain('auto-resolves');
  });

  // Issue #4306 nit fixes: mget also advertises its own --download-resources,
  // and the single-attachment example lands under ./lark-im-resources/ — the
  // same default dir as the other two commands (no ./downloads/ drift).
  it('should keep lark-cli download paths consistent across the three commands', () => {
    const result = buildThreadContextSection('context here');
    // mget bullet itself mentions --download-resources (scoped to the mget
    // command via regex — --download-resources also appears on the list line).
    expect(result).toMatch(/\+messages-mget\b[^`]*--download-resources/);
    // Single-attachment download example uses ./lark-im-resources/<name>,
    // matching the default dir stated in the prose (no ./downloads/ drift).
    expect(result).toContain('./lark-im-resources/<name>');
    expect(result).not.toContain('./downloads/');
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
    // Issue #4261: rolling monthly files, not a single ever-growing file.
    expect(result).toContain('.claude/task-records/YYYY-MM.md');
  });

  it('should instruct rolling monthly storage (Issue #4261)', () => {
    const result = buildTaskRecordGuidance();
    // The concrete example month must track the live current month, not a
    // hardcoded literal — otherwise it goes stale and misleads the agent once
    // the calendar rolls over.
    const now = new Date();
    const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prev = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
    expect(result).toContain(`task-records/${cur}.md`);
    expect(result).toContain(`task-records/${prev}.md`);
    expect(result).not.toMatch(/Append entries to `\.claude\/task-records\.md`/);
  });

  it('should bound the read-before-estimating window (Issue #4261)', () => {
    const result = buildTaskRecordGuidance();
    expect(result).toContain('Read existing records before estimating');
    expect(result).toContain('bounded recent window');
    expect(result).toContain('previous month');
    expect(result).toContain('never load it fully');
  });

  it('should instruct writing a top-level heading when creating a new file', () => {
    const result = buildTaskRecordGuidance();
    // The Example block shows a `# Task Records` H1, so Storage Location must
    // tell the agent to write that heading on first creation — otherwise new
    // monthly files lack the top-level title the example implies.
    expect(result).toContain('# Task Records');
    expect(result).toMatch(/when creating it for the first time/i);
  });

  it('should bound the legacy tail-read to a concrete line limit', () => {
    const result = buildTaskRecordGuidance();
    // "tail-read" alone is too soft a bound for a multi-thousand-line legacy
    // file — pin it to a concrete ~N lines so the agent never full-loads it.
    expect(result).toMatch(/~\d+ lines/);
    expect(result).toContain('legacy');
    expect(result).toContain('never load it fully');
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
