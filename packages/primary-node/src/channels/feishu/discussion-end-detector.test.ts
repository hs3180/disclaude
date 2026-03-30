/**
 * Tests for DiscussionEndDetector.
 *
 * Issue #1229: Smart session end via trigger phrases.
 */

import { describe, it, expect } from 'vitest';
import { detectAndStripDiscussionEnd } from './discussion-end-detector.js';

describe('detectAndStripDiscussionEnd', () => {
  // ─── No trigger detected ─────────────────────────────────────

  it('returns detected=false for plain text', () => {
    const result = detectAndStripDiscussionEnd('Hello, world!');
    expect(result.detected).toBe(false);
    expect(result.cleanText).toBe('Hello, world!');
    expect(result.reason).toBeUndefined();
  });

  it('returns detected=false for text with similar but non-matching brackets', () => {
    const result = detectAndStripDiscussionEnd('[DISCUSSION_START]');
    expect(result.detected).toBe(false);
    expect(result.cleanText).toBe('[DISCUSSION_START]');
  });

  it('returns detected=false for empty string', () => {
    const result = detectAndStripDiscussionEnd('');
    expect(result.detected).toBe(false);
    expect(result.cleanText).toBe('');
  });

  // ─── [DISCUSSION_END] ───────────────────────────────────────

  it('detects [DISCUSSION_END] and strips it', () => {
    const result = detectAndStripDiscussionEnd('Thanks for the discussion! [DISCUSSION_END]');
    expect(result.detected).toBe(true);
    expect(result.cleanText).toBe('Thanks for the discussion!');
    expect(result.reason).toBeUndefined();
  });

  it('detects [DISCUSSION_END] alone', () => {
    const result = detectAndStripDiscussionEnd('[DISCUSSION_END]');
    expect(result.detected).toBe(true);
    expect(result.cleanText).toBe('');
    expect(result.reason).toBeUndefined();
  });

  // ─── [DISCUSSION_END:timeout] ────────────────────────────────

  it('detects [DISCUSSION_END:timeout] with reason', () => {
    const result = detectAndStripDiscussionEnd('Time is up! [DISCUSSION_END:timeout]');
    expect(result.detected).toBe(true);
    expect(result.cleanText).toBe('Time is up!');
    expect(result.reason).toBe('timeout');
  });

  // ─── [DISCUSSION_END:abandoned] ──────────────────────────────

  it('detects [DISCUSSION_END:abandoned] with reason', () => {
    const result = detectAndStripDiscussionEnd('[DISCUSSION_END:abandoned]');
    expect(result.detected).toBe(true);
    expect(result.cleanText).toBe('');
    expect(result.reason).toBe('abandoned');
  });

  // ─── [DISCUSSION_END:summary=...] ────────────────────────────

  it('detects [DISCUSSION_END:summary=reached consensus]', () => {
    const result = detectAndStripDiscussionEnd(
      'We agreed on the approach. [DISCUSSION_END:summary=reached consensus on v2 design]',
    );
    expect(result.detected).toBe(true);
    expect(result.cleanText).toBe('We agreed on the approach.');
    expect(result.reason).toBe('summary=reached consensus on v2 design');
  });

  // ─── Edge cases ─────────────────────────────────────────────

  it('handles text before and after trigger', () => {
    const result = detectAndStripDiscussionEnd('Before [DISCUSSION_END] After');
    expect(result.detected).toBe(true);
    expect(result.cleanText).toBe('Before  After');
  });

  it('handles multiline text with trigger', () => {
    const result = detectAndStripDiscussionEnd('Line 1\nLine 2\n[DISCUSSION_END:timeout]\nAfter');
    expect(result.detected).toBe(true);
    expect(result.reason).toBe('timeout');
    expect(result.cleanText).toBe('Line 1\nLine 2\n\nAfter');
  });

  it('strips all triggers if multiple exist', () => {
    const result = detectAndStripDiscussionEnd('[DISCUSSION_END] [DISCUSSION_END:timeout]');
    expect(result.detected).toBe(true);
    expect(result.cleanText).toBe('');
  });

  it('handles custom reason values', () => {
    const result = detectAndStripDiscussionEnd('Done. [DISCUSSION_END:completed]');
    expect(result.detected).toBe(true);
    expect(result.reason).toBe('completed');
  });
});
