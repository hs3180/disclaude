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
  buildThreadSelfServiceGuidance,
  buildNextStepGuidance,
  buildOutputFormatGuidance,
  buildTaskRecordGuidance,
  buildLocationAwarenessGuidance,
} from './guidance.js';
import {
  CHANNEL_CLI_HELP,
  buildChannelCliHelpGuidance,
} from './channel-cli-help.js';
import { REST_IPC_DEFAULT_BASE_URL } from '../../ipc/rest-ipc-client.js';

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

  // Issue #4402: the lark-cli self-service guidance was EXTRACTED from
  // buildThreadContextSection into buildThreadSelfServiceGuidance (so it can be
  // injected based on isTopicThread, independent of threadContext pre-build).
  // buildThreadContextSection must no longer carry it (avoids duplication).
  it('should NOT include lark-cli guidance after the #4402 extraction', () => {
    const result = buildThreadContextSection('context here');
    expect(result).not.toContain('lark-cli');
    expect(result).not.toContain('+threads-messages-list');
  });
});

describe('buildThreadSelfServiceGuidance (Issue #4402)', () => {
  // Issue #4306: tell the agent how to fetch thread context / attachments on
  // demand via lark-cli (ancestor-message attachments are not auto-delivered).
  it('should include lark-cli on-demand thread context / attachment guidance', () => {
    const result = buildThreadSelfServiceGuidance();
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
    const result = buildThreadSelfServiceGuidance();
    // mget bullet itself mentions --download-resources (scoped to the mget
    // command via regex — --download-resources also appears on the list line).
    expect(result).toMatch(/\+messages-mget\b[^`]*--download-resources/);
    // Single-attachment download example uses ./lark-im-resources/<name>,
    // matching the default dir stated in the prose (no ./downloads/ drift).
    expect(result).toContain('./lark-im-resources/<name>');
    expect(result).not.toContain('./downloads/');
  });

  it('always returns the guidance (caller gates on isTopicThread)', () => {
    // No threadContext parameter — injection is the caller's responsibility.
    expect(buildThreadSelfServiceGuidance()).toContain('Topic-thread self-service');
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
    expect(result).toContain('task-records/YYYY-MM.md');
    expect(result).toContain('legacy');
    expect(result).toContain('.claude/task-records');
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

// Issue #4705: canonical channel CLI help exposed to the agent prompt, kept in
// sync with the CLI's own `help` output (single source of truth).
describe('buildChannelCliHelpGuidance', () => {
  it('CHANNEL_CLI_HELP includes every command (the source of truth)', () => {
    expect(CHANNEL_CLI_HELP).toContain('send_text');
    expect(CHANNEL_CLI_HELP).toContain('send_file');
    expect(CHANNEL_CLI_HELP).toContain('send_card');
    expect(CHANNEL_CLI_HELP).toContain('send_interactive');
    // `push` is the agent-facing spelling; `push_to_agent` is the internal
    // canonical name and must not leak into user-facing help.
    expect(CHANNEL_CLI_HELP).toMatch(/^\s*push\s+Push an instruction/m);
    expect(CHANNEL_CLI_HELP).not.toContain('push_to_agent');
  });

  it('CHANNEL_CLI_HELP does not advertise the removed disclaude-channel bin', () => {
    expect(CHANNEL_CLI_HELP).not.toContain('disclaude-channel');
    expect(CHANNEL_CLI_HELP).toContain('disclaude channel <command> [options]');
  });

  it('CHANNEL_CLI_HELP sources its default base URL from the shared constant', () => {
    expect(CHANNEL_CLI_HELP).toContain(REST_IPC_DEFAULT_BASE_URL);
  });

  it('should include the canonical command vocabulary', () => {
    const result = buildChannelCliHelpGuidance();
    expect(result).toContain('Channel CLI');
    expect(result).toContain('send_text');
    expect(result).toContain('send_file');
    expect(result).toContain('send_card');
    expect(result).toContain('send_interactive');
    expect(result).toContain('`push`');
    expect(result).not.toContain('push_to_agent');
  });

  it('should render the default invoke prefix (disclaude channel)', () => {
    const result = buildChannelCliHelpGuidance();
    expect(result).toContain('`disclaude channel help`');
  });

  it('should honor a custom invoke prefix', () => {
    const result = buildChannelCliHelpGuidance('node /opt/cli.mjs');
    expect(result).toContain('`node /opt/cli.mjs help`');
  });

  it('narrows the advertised commands to the channel capabilities', () => {
    const result = buildChannelCliHelpGuidance('disclaude channel', {
      sendCommands: ['send_text'],
    });
    expect(result).toContain('`send_text`');
    // Must not re-advertise what the caller's capability notes just denied.
    expect(result).not.toContain('`send_file`');
    expect(result).not.toContain('`send_card`');
    expect(result).not.toContain('`send_interactive`');
    // The --file hint is dropped along with send_file.
    expect(result).not.toContain('needs `--file <path>`');
    // `push` is agent-to-agent, never gated by channel send capabilities.
    expect(result).toContain('`push`');
  });

  it('should return empty string when disabled', () => {
    expect(buildChannelCliHelpGuidance('disclaude channel', { enabled: false })).toBe('');
  });
});
