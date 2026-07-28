/**
 * Streaming placeholder card builder (Feishu Card Kit JSON 2.0).
 *
 * Issue #4396 (#4208 P1-b): emits a schema-2.0 streaming placeholder card with
 * stable `element_id`s so the Card Kit client (#4395) knows exactly which
 * element to PUT during typewriter streaming, and the ChatAgent streaming
 * state machine (#4399 / P2-b) knows where to write thinking vs reply text.
 *
 * Mixed-schema policy (#4238): the streaming card is JSON-2.0
 * (`schema: "2.0"`, `config.streaming_mode`, `body.elements` carrying
 * `element_id`); all other disclaude cards stay JSON-1.0 (`wide_screen_mode`,
 * root-level `elements`) to limit blast radius. This card therefore
 * intentionally does NOT conform to the 1.0-shaped `FeishuCard` type.
 *
 * Schema verified against the live Card Kit API (2026-07-29, `cardkit/v1` via
 * `lark-cli --as bot`): only a top-level `markdown`/`plain_text` element is a
 * valid streaming target — a `div` wrapper is rejected ("tag is not supported,
 * tag:div"), a top-level `lark_md` is rejected ("type of element is not
 * supported tag: lark_md"), and `element_id` must be ≤ 20 chars
 * (alphabetic start, `[a-zA-Z0-9_]` only). The streaming update itself is a
 * **PUT** `/cards/{card_id}/elements/{element_id}/content` (NOT PATCH, which
 * 404s at the gateway); see [[cardkit-endpoint-research-4238-reverted]].
 *
 * @see https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-structure
 */

/** Stable element_id for the thinking / stream-of-thought region (≤ 20 chars). */
export const STREAMING_THINKING_ELEMENT_ID = 'streaming_thinking';

/** Stable element_id for the reply region, the final answer (≤ 20 chars). */
export const STREAMING_REPLY_ELEMENT_ID = 'streaming_reply';

/** Default thinking-region placeholder shown while the agent is working. */
export const STREAMING_THINKING_PLACEHOLDER = '🤔 思考中…';

/**
 * A streamable text element in a JSON-2.0 card body. The `element_id` is the
 * target of `PUT /cardkit/v1/cards/{card_id}/elements/{element_id}/content`
 * (body: `{ content, sequence, uuid }`; `sequence` strictly increases across
 * the whole card). Live-verified: must be a top-level `markdown` (or
 * `plain_text`) element — NOT a `div` wrapper, and `element_id` ≤ 20 chars.
 */
export interface StreamingCardElement {
  tag: 'markdown';
  /** Stable id (≤ 20 chars) the Card Kit client PUTs during streaming. */
  element_id: string;
  content: string;
}

/**
 * Feishu Card Kit JSON-2.0 streaming placeholder card.
 *
 * Note: this is the 2.0 shape (`schema` + `body.elements`) and intentionally
 * does NOT satisfy the 1.0 `FeishuCard` type (which requires root-level
 * `elements` / `header`).
 */
export interface StreamingCard {
  schema: '2.0';
  config: {
    /** Enables Card Kit native streaming (typewriter + breathing cursor). */
    streaming_mode: true;
  };
  body: {
    elements: [StreamingCardElement, StreamingCardElement];
  };
}

export interface BuildStreamingCardOptions {
  /** Overrides the default thinking placeholder. */
  thinkingPlaceholder?: string;
}

/**
 * Build a JSON-2.0 streaming placeholder card with stable element_ids.
 *
 * - Thinking region: initialized to the placeholder (PUT as stream-of-thought
 *   arrives, then cleared/replaced on finalize via PATCH /settings).
 * - Reply region: initialized empty (filled by streaming PUTs).
 *
 * The returned element_ids are exported as `STREAMING_THINKING_ELEMENT_ID` /
 * `STREAMING_REPLY_ELEMENT_ID` so the client and state machine reference the
 * exact same targets the card was built with.
 */
export function buildStreamingPlaceholderCard(
  options: BuildStreamingCardOptions = {},
): StreamingCard {
  const thinkingContent = options.thinkingPlaceholder ?? STREAMING_THINKING_PLACEHOLDER;
  return {
    schema: '2.0',
    config: { streaming_mode: true },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: STREAMING_THINKING_ELEMENT_ID,
          content: thinkingContent,
        },
        {
          tag: 'markdown',
          element_id: STREAMING_REPLY_ELEMENT_ID,
          content: '',
        },
      ],
    },
  };
}
