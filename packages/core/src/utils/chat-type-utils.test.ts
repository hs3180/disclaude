/**
 * Tests for chat type classification utilities.
 *
 * Issue #4136: chat type must be derived from the `chat_type` field, never from
 * chat ID prefixes.
 */

import { describe, it, expect } from 'vitest';
import { isGroupChat, isPrivateChat } from './chat-type-utils.js';

describe('isGroupChat', () => {
  it('returns true for group', () => {
    expect(isGroupChat('group')).toBe(true);
  });

  it('returns true for topic (thread inside a group)', () => {
    expect(isGroupChat('topic')).toBe(true);
  });

  it('returns false for p2p', () => {
    expect(isGroupChat('p2p')).toBe(false);
  });

  it('returns false for undefined / unknown types', () => {
    expect(isGroupChat(undefined)).toBe(false);
    expect(isGroupChat('unknown')).toBe(false);
    expect(isGroupChat('')).toBe(false);
  });

  it('never inspects chat ID prefixes', () => {
    // A chat ID is an address, not a type signal — prefixes must be ignored.
    expect(isGroupChat('oc_abc123')).toBe(false);
    expect(isGroupChat('ou_abc123')).toBe(false);
  });
});

describe('isPrivateChat', () => {
  it('returns true for p2p', () => {
    expect(isPrivateChat('p2p')).toBe(true);
  });

  it('returns false for group and topic', () => {
    expect(isPrivateChat('group')).toBe(false);
    expect(isPrivateChat('topic')).toBe(false);
  });

  it('returns false for undefined / unknown types', () => {
    expect(isPrivateChat(undefined)).toBe(false);
    expect(isPrivateChat('unknown')).toBe(false);
    expect(isPrivateChat('')).toBe(false);
  });

  it('never inspects chat ID prefixes', () => {
    expect(isPrivateChat('ou_abc123')).toBe(false);
    expect(isPrivateChat('oc_abc123')).toBe(false);
  });
});
