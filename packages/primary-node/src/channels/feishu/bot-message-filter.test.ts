/**
 * Tests for bot message filtering with @mention bypass.
 *
 * Issue #1742: Allow bot messages through when they @mention our bot.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MentionDetector } from './mention-detector.js';

// ============================================================================
// Tests: MentionDetector
// ============================================================================

describe('MentionDetector bot-to-bot support (Issue #1742)', () => {
  let detector: MentionDetector;

  beforeEach(() => {
    detector = new MentionDetector();
    vi.clearAllMocks();
  });

  it('should detect bot mention by open_id', () => {
    // Simulate bot info being set
    (detector as any).botInfo = {
      open_id: 'cli_our_bot',
      app_id: 'app_our_bot',
    };

    const mentions = [
      {
        id: { open_id: 'cli_our_bot' },
        key: '@_bot_1',
        name: { name: 'Our Bot' },
      },
    ];

    expect(detector.isBotMentioned(mentions as any)).toBe(true);
  });

  it('should detect bot mention by app_id', () => {
    (detector as any).botInfo = {
      open_id: 'cli_our_bot',
      app_id: 'app_our_bot',
    };

    const mentions = [
      {
        id: { open_id: 'app_our_bot' },
        key: '@_bot_1',
        name: { name: 'Our Bot' },
      },
    ];

    expect(detector.isBotMentioned(mentions as any)).toBe(true);
  });

  it('should not match when mentions are for a different bot', () => {
    (detector as any).botInfo = {
      open_id: 'cli_our_bot',
      app_id: 'app_our_bot',
    };

    const mentions = [
      {
        id: { open_id: 'cli_other_bot' },
        key: '@_bot_2',
        name: { name: 'Other Bot' },
      },
    ];

    expect(detector.isBotMentioned(mentions as any)).toBe(false);
  });

  it('should return false for empty mentions', () => {
    (detector as any).botInfo = {
      open_id: 'cli_our_bot',
      app_id: 'app_our_bot',
    };

    expect(detector.isBotMentioned([] as any)).toBe(false);
    expect(detector.isBotMentioned(undefined as any)).toBe(false);
  });

  it('should use fallback pattern matching when botInfo is not set', () => {
    // No bot info fetched — use fallback heuristics
    (detector as any).botInfo = undefined;

    const mentions = [
      {
        id: { open_id: 'cli_some_bot' },
        key: '@_bot_1',
        name: { name: 'Some Bot' },
      },
    ];

    // Fallback: checks for cli_ prefix or 'bot' in key
    expect(detector.isBotMentioned(mentions as any)).toBe(true);
  });

  it('should support multiple mentions and detect our bot among them', () => {
    (detector as any).botInfo = {
      open_id: 'cli_our_bot',
      app_id: 'app_our_bot',
    };

    const mentions = [
      {
        id: { open_id: 'ou_user123' },
        key: '@Alice',
        name: { name: 'Alice' },
      },
      {
        id: { open_id: 'cli_our_bot' },
        key: '@_bot_1',
        name: { name: 'Our Bot' },
      },
      {
        id: { open_id: 'ou_user456' },
        key: '@Bob',
        name: { name: 'Bob' },
      },
    ];

    expect(detector.isBotMentioned(mentions as any)).toBe(true);
  });
});
