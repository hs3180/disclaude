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
  buildLocationAwarenessGuidance,
  buildRuntimeEnvironmentGuidance,
} from './guidance.js';
import { CHANNEL_CLI_HELP, buildChannelCliHelpGuidance } from './channel-cli-help.js';

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

  it('should not offer pending-question guidance for ordinary history context', () => {
    const result = buildChatHistorySection('User asked a question');
    expect(result).not.toContain('genuine empty text @mention');
    expect(result).not.toContain('clearly unanswered request');
  });

  it('should include guarded pending-question guidance only for an eligible empty text mention', () => {
    const result = buildChatHistorySection('User asked a question', true);
    expect(result).toContain('genuine empty text @mention');
    expect(result).toContain('clearly unanswered request');
    expect(result).toContain('already been answered or superseded');
    expect(result).toContain('ask what the user needs');
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

describe('topic-thread context', () => {
  it('retrieves missing context only from the current thread, even without injected history', () => {
    const result = buildThreadSelfServiceGuidance();
    expect(result).toContain('Thread Root ID');
    expect(result).toContain('partial');
    expect(result).toContain('proactively retrieve missing');
    expect(result).toContain('skip retrieval when the supplied context is sufficient');
    expect(result).toContain('another thread');
    expect(result).toContain('rather than guessing');
    for (const command of ['+threads-messages-list', '+messages-mget', '+messages-resources-download']) {
      expect(result).toContain(command);
    }
    expect(result).toMatch(/\+messages-mget\b[^`]*--download-resources/);
    expect(result).toContain('./lark-im-resources/<name>');
    expect(result).not.toContain('./downloads/');
  });
});

describe('contextual next steps', () => {
  it('keeps meaningful recommendations optional and skips routine exchanges', () => {
    for (const result of [buildNextStepGuidance(true), buildNextStepGuidance(false), buildThreadSelfServiceGuidance()]) {
      expect(result).toContain('one concrete, optional next step');
      expect(result).toContain('even when the immediate request is complete');
      expect(result).toContain('Skip routine exchanges');
      expect(result).toContain('finish naturally');
      expect(result).toContain('before the user chooses');
      expect(result).not.toContain('Always');
    }
  });

  it('requires actual feedback before offering revision, including topic threads (#5238)', () => {
    for (const result of [buildNextStepGuidance(true), buildNextStepGuidance(false), buildThreadSelfServiceGuidance()]) {
      expect(result).toContain('only on feedback already received');
      expect(result).toContain('no reviewer feedback, confirm delivery and finish');
      expect(result).toContain('revisit revision when specific feedback arrives');
      expect(result).toContain('Do not ask the user to precommit');
    }
  });

  it('preserves the Project report and evidence/user-edit boundaries', () => {
    const result = buildNextStepGuidance();
    expect(result).toContain('human-readable report in the existing Project');
    expect(result).toContain('distinguish observed results from interpretation');
    expect(result).toContain('exploration in the Project archive');
    expect(result).toContain('preserve user edits');
    expect(result).toContain('make substantive revisions visible');
  });

  it('uses cards only when supported and useful, without injecting their full parameter template', () => {
    expect(buildNextStepGuidance(true)).toContain('send_interactive');
    expect(buildNextStepGuidance()).toContain('send_interactive');
    expect(buildNextStepGuidance(true)).toContain('materially benefits from buttons');
    expect(buildNextStepGuidance(false)).not.toContain('send_interactive');
    expect(buildThreadSelfServiceGuidance(false)).not.toContain('send_interactive');
    expect(buildNextStepGuidance(false)).toContain('briefly in chat');
    expect(buildNextStepGuidance(true)).not.toContain('--options');
    expect(buildNextStepGuidance(true)).not.toContain('--action-prompts');
  });
});

describe('output and environment boundaries', () => {
  it('respects explicit JSON and code-only formats instead of enforcing Markdown (#5019)', () => {
    const result = buildOutputFormatGuidance();
    expect(result).toContain('Markdown by default');
    expect(result).toContain('including raw JSON or code-only output');
    expect(result).toContain('do not add a preamble, card, or unrelated task record');
    expect(result).not.toContain('Never output raw JSON');
    expect(result).not.toContain('Correct Format');
  });

  it('does not infer the user location from server metadata', () => {
    const result = buildLocationAwarenessGuidance();
    expect(result).toContain('timezone, IP address, Wi-Fi or locale');
    expect(result).toContain('does not reveal');
    expect(result).toContain('only when it is needed and has not been provided');
  });

  it('retains shared credential state and running-child verification safeguards', () => {
    const result = buildRuntimeEnvironmentGuidance();
    expect(result).toContain('.runtime-env');
    expect(result).toContain('preserve unrelated entries');
    expect(result).toContain('intended and authorized');
    expect(result).toContain('owner-only');
    expect(result).toContain('previous environment');
    expect(result).toContain('poll the same handle');
    expect(result).toContain('underlying command reaches a terminal result');
    expect(result).toContain('outer orchestration cell completing');
    expect(result).toContain('not permission to restart');
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
    expect(CHANNEL_CLI_HELP).toContain('required unless supplied by the managed environment');
    expect(CHANNEL_CLI_HELP).not.toContain('19200');
  });

  // PR #4803 added this paragraph to the CLI's own help. Nothing asserted it, so
  // aliasing `HELP = CHANNEL_CLI_HELP` would have silently dropped it while CI
  // stayed green: the `rejectUnknownFlags` behaviour survives, its documentation
  // does not. Guard the text so the next same-shaped drift fails loudly.
  it('CHANNEL_CLI_HELP documents that unknown flags are rejected', () => {
    expect(CHANNEL_CLI_HELP).toContain('Unknown options are rejected and named');
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
