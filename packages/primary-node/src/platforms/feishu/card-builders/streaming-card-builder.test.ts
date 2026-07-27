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
    expect(thinking.text.content).toBe(STREAMING_THINKING_PLACEHOLDER);
  });

  it('initializes the reply region empty (filled by streaming PATCHes)', () => {
    const [, reply] = buildStreamingPlaceholderCard().body.elements;
    expect(reply.text.content).toBe('');
  });

  it('uses div + lark_md text blocks (Card Kit 2.0 text element shape)', () => {
    for (const el of buildStreamingPlaceholderCard().body.elements) {
      expect(el.tag).toBe('div');
      expect(el.text.tag).toBe('lark_md');
    }
  });

  it('allows overriding the thinking placeholder while keeping element_ids stable', () => {
    const card = buildStreamingPlaceholderCard({ thinkingPlaceholder: '🌀 Working…' });
    expect(card.body.elements[0].text.content).toBe('🌀 Working…');
    expect(card.body.elements[1].text.content).toBe('');
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
              "element_id": "streaming_thinking_region",
              "tag": "div",
              "text": {
                "content": "🤔 思考中…",
                "tag": "lark_md",
              },
            },
            {
              "element_id": "streaming_reply_region",
              "tag": "div",
              "text": {
                "content": "",
                "tag": "lark_md",
              },
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
