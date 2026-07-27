/**
 * Streaming placeholder card builder (Feishu Card Kit JSON 2.0).
 *
 * Issue #4396 (#4208 P1-b): emits a schema-2.0 streaming placeholder card with
 * stable `element_id`s so the Card Kit client (#4395) knows exactly which
 * element to PATCH during typewriter streaming, and the ChatAgent streaming
 * state machine (#4399 / P2-b) knows where to write thinking vs reply text.
 *
 * Mixed-schema policy (#4238): the streaming card is JSON-2.0
 * (`schema: "2.0"`, `config.streaming_mode`, `body.elements` carrying
 * `element_id`); all other disclaude cards stay JSON-1.0 (`wide_screen_mode`,
 * root-level `elements`) to limit blast radius. This card therefore
 * intentionally does NOT conform to the 1.0-shaped `FeishuCard` type.
 *
 * Pure builder — no wiring, no caller yet. Schema follows Feishu Card Kit 2.0
 * and the #4238 research findings; the exact field placement can be
 * reconciled against a live PATCH when #4395 lands.
 *
 * @see https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-structure
 */

/** Stable element_id for the thinking / stream-of-thought region. */
export const STREAMING_THINKING_ELEMENT_ID = 'streaming_thinking_region';

/** Stable element_id for the reply region (the final answer). */
export const STREAMING_REPLY_ELEMENT_ID = 'streaming_reply_region';

/** Default thinking-region placeholder shown while the agent is working. */
export const STREAMING_THINKING_PLACEHOLDER = '🤔 思考中…';

/**
 * A text block element in a JSON-2.0 card body. The `element_id` is the target
 * of `PATCH /cardkit/v1/cards/{card_id}/elements/{element_id}/content`.
 */
export interface StreamingCardElement {
  tag: 'div';
  /** Stable id the Card Kit client PATCHes during streaming. */
  element_id: string;
  text: {
    tag: 'lark_md';
    content: string;
  };
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
 * - Thinking region: initialized to the placeholder (PATCHed as
 *   stream-of-thought arrives, then cleared/replaced on finalize).
 * - Reply region: initialized empty (filled by streaming PATCHes).
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
          tag: 'div',
          element_id: STREAMING_THINKING_ELEMENT_ID,
          text: { tag: 'lark_md', content: thinkingContent },
        },
        {
          tag: 'div',
          element_id: STREAMING_REPLY_ELEMENT_ID,
          text: { tag: 'lark_md', content: '' },
        },
      ],
    },
  };
}
