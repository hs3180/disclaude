/**
 * Tests for the JSON-2.0 streaming placeholder card builder (Issue #4396 / #4208 P1-b).
 *
 * Locks the contract the Card Kit client (#4395) and the ChatAgent streaming
 * state machine (#4399 / P2-b) will rely on: schema 2.0, streaming_mode on,
 * two stable element_ids, thinking placeholder, empty reply region.
 */
import { describe, it, expect } from 'vitest';
import {
  buildStreamingPlaceholderCard,
  STREAMING_THINKING_ELEMENT_ID,
  STREAMING_REPLY_ELEMENT_ID,
  STREAMING_THINKING_PLACEHOLDER,
} from './streaming-card-builder.js';

describe('buildStreamingPlaceholderCard (Issue #4396 / #4208 P1-b)', () => {
  it('emits a JSON-2.0 card (schema "2.0")', () => {
    expect(buildStreamingPlaceholderCard().schema).toBe('2.0');
  });

  it('enables Card Kit native streaming mode', () => {
    expect(buildStreamingPlaceholderCard().config.streaming_mode).toBe(true);
  });

  it('has exactly two body elements (thinking + reply) in order', () => {
    const { elements } = buildStreamingPlaceholderCard().body;
    expect(elements).toHaveLength(2);
    expect(elements.map((e) => e.element_id)).toEqual([
      STREAMING_THINKING_ELEMENT_ID,
      STREAMING_REPLY_ELEMENT_ID,
    ]);
  });

  it('initializes the thinking region to the placeholder', () => {
    const [thinking] = buildStreamingPlaceholderCard().body.elements;
    expect(thinking.content).toBe(STREAMING_THINKING_PLACEHOLDER);
  });

  it('initializes the reply region empty (filled by streaming PUTs)', () => {
    const [, reply] = buildStreamingPlaceholderCard().body.elements;
    expect(reply.content).toBe('');
  });

  it('uses top-level markdown elements (the only streamable Card Kit 2.0 shape)', () => {
    for (const el of buildStreamingPlaceholderCard().body.elements) {
      // Live-verified: only top-level `markdown`/`plain_text` elements accept a
      // streaming content PUT — a `div` wrapper is rejected by Card Kit.
      expect(el.tag).toBe('markdown');
      expect(el).not.toHaveProperty('text');
    }
  });

  it('keeps every element_id within the Card Kit 20-char limit (live-verified)', () => {
    for (const el of buildStreamingPlaceholderCard().body.elements) {
      expect(el.element_id.length).toBeLessThanOrEqual(20);
      // Card Kit rule: alphabetic start, [a-zA-Z0-9_] only.
      expect(el.element_id).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
  });

  it('allows overriding the thinking placeholder while keeping element_ids stable', () => {
    const card = buildStreamingPlaceholderCard({ thinkingPlaceholder: '🌀 Working…' });
    expect(card.body.elements[0].content).toBe('🌀 Working…');
    expect(card.body.elements[1].content).toBe('');
    expect(card.body.elements.map((e) => e.element_id)).toEqual([
      STREAMING_THINKING_ELEMENT_ID,
      STREAMING_REPLY_ELEMENT_ID,
    ]);
  });

  it('snapshot: stable full card shape (locks the contract for the Card Kit client)', () => {
    expect(buildStreamingPlaceholderCard()).toMatchInlineSnapshot(`
      {
        "body": {
          "elements": [
            {
              "content": "🤔 思考中…",
              "element_id": "streaming_thinking",
              "tag": "markdown",
            },
            {
              "content": "",
              "element_id": "streaming_reply",
              "tag": "markdown",
            },
          ],
        },
        "config": {
          "streaming_mode": true,
        },
        "schema": "2.0",
      }
    `);
  });
});
