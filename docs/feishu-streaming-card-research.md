# Feishu Streaming Card — API verification for #4208

> Research note clearing the **待核实** blocker in [#4208](https://github.com/hs3180/disclaude/issues/4208) (飞书流式卡片支持).
> Verified against Feishu open-platform docs + the disclaude codebase + installed SDK on **2026-07-09**.
> Scope of this doc: **文档核实** only. **频控实测** (actual rate-limit measurement) is deferred — it needs a running Feishu integration.

## TL;DR

- #4208 wants **native in-place streaming** (客户端原生呼吸光标 / 打字机动效). The correct API is the
  **Card Kit streaming** endpoint — **not** `im.message.patch` (which is a traditional full-overwrite
  that only *simulates* streaming via high-frequency calls).
- Streaming cards **require card JSON 2.0** + `config.streaming_mode = true`.
- disclaude today emits **card JSON 1.0** (`wide_screen_mode`, `column_set`) and `FeishuAdapter.update()`
  routes to `client.im.message.patch()`. Neither supports native streaming.
- **SDK gap (verified):** `@larksuiteoapi/node-sdk@1.59.0` has **no Card Kit client** (`client.cardkit.*`
  does not exist). Native streaming therefore needs **raw-HTTP REST calls** (tenant access token +
  `PATCH /open-apis/cardkit/v1/...`), or an SDK upgrade once Card Kit is supported upstream.

## The two update mechanisms

### A. Card Kit streaming (native — recommended for #4208)

Native incremental render (typewriter). Docs: Card Kit v1.

Flow:

1. **Create** the message with a JSON-2.0 card whose `config.streaming_mode = true`. Capture
   `card_id` from the create-message response (the entity id used by the Card Kit endpoints —
   distinct from `message_id`).
2. **Stream text** per element:
   `PATCH /open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content`
   Pass the **cumulative full text** for a `plain_text` or `markdown` element; the client renders
   only the delta (typewriter). **Only `plain_text` / `markdown` elements are streamable.**
3. **Finalize** with a full or partial card update:
   `PATCH /open-apis/cardkit/v1/cards/{card_id}` (full overwrite) or
   `PATCH /open-apis/cardkit/v1/cards/{card_id}/batch_update` (partial). Use this to write the final
   answer and drop the streaming indicator.

Key points:

- Requires **card JSON 2.0**.
- `streaming_mode` lives in the card `config` (not a request header).
- Streaming-text updates target a specific `element_id`, so the placeholder card must own a stable
  element for the streaming content.

### B. im.message.patch (traditional — what disclaude uses today)

`PATCH /open-apis/im/v1/messages/{message_id}` — full card JSON overwrite each call.

- Simulates streaming by high-frequency full rewrites; **not** native incremental render.
- Requires `config.update_multi: true` on the card.
- Only updates cards sent within the last **14 days**; subject to frequency limits (numbers not
  published in the docs reviewed here → 频控实测).
- disclaude's `FeishuAdapter.update()` already does this (`client.im.message.patch`, `feishu-adapter.ts:562`).

#4208's "客户端原生呼吸光标 / 打字机动效" points at **A**, not B.

## Answers to #4208's "待核实"

1. **流式标识字段 / header 写法** → `config.streaming_mode = true` on a JSON-2.0 card (Card Kit). Not
   a header. The streaming updates themselves go through the Card Kit element-content endpoint, not
   `im.message.patch`.
2. **im.message.patch 频率上限 / 流式专属配额** → `im.message.patch` is the traditional full-overwrite
   path (rate-limited, 14-day window, `update_multi` required). The **streaming-dedicated channel is
   Card Kit** (`/cardkit/v1/...`); its exact rate limits are not stated in the docs reviewed and should
   be measured against a live app (→ 频控实测, deferred).
3. **schema 2.0 在 disclaude 现有卡片通道的兼容性** → disclaude currently emits **JSON 1.0** cards
   (`config.wide_screen_mode`, `column_set`/`column` elements — see `feishu-adapter.ts`,
   `channel-mcp.ts`, `tools/tool-definitions.ts`, `utils/table-converter.ts`). JSON 2.0 is **required**
   for streaming. A mixed approach limits blast radius: build the **streaming placeholder card as 2.0**,
   leave non-streaming cards on 1.0.

## Correction to the #4208 plan

#4208 says "复用已有的 `FeishuAdapter.update()`". `update()` uses `im.message.patch` (traditional
full-overwrite) — it can *simulate* streaming but is **not** the native streaming path the issue's UX
calls for. For native streaming, add a **new** method on `FeishuAdapter` that drives the Card Kit
streaming endpoint (create-with-`streaming_mode` → patch element content → finalize), and keep
`update()` for ordinary (non-streaming) card patches.

## SDK support (verified)

`@larksuiteoapi/node-sdk@1.59.0` (the version disclaude pins) exposes **no Card Kit client** — there is
no `client.cardkit.*` surface, and the dist contains no `/cardkit/` paths. Consequences for the code PR:

- `client.im.message.create()` can still create the 2.0 streaming card (message creation is
  SDK-supported); the response carries the `card_id` needed for streaming.
- The streaming PATCH calls (`/cardkit/v1/cards/{card_id}/elements/{element_id}/content`,
  `/cardkit/v1/cards/{card_id}`) must be made via **raw HTTP** with the app's tenant access token
  (the same token the SDK obtains), OR via a manual `fetch` wrapper — until the SDK adds Card Kit.

## Suggested implementation skeleton (for the code PR — not this doc's scope)

- `FeishuAdapter.startStreaming(placeholderCard2_0) → { messageId, cardId, elementId }`
- `FeishuAdapter.streamText(cardId, elementId, cumulativeText)` — throttled 200–500 ms (per #4208);
  **per-session** throttle (per #4203 Not-in-scope #2, now in #4208 scope).
- `FeishuAdapter.finalizeStreaming(cardId, finalCard)` — full update, drop streaming flag.
- ChatAgent: first thinking tick → `startStreaming`; subsequent ticks → `streamText`; reply start /
  done → `finalizeStreaming` (per #4208 state machine).
- A small raw-HTTP Card Kit client (tenant token + `fetch`) for the PATCH calls.

## Out of scope for this doc PR

- Actual code wiring (separate PR; touches the ChatAgent stream — needs care + integration tests).
- **频控实测** — measure `im.message.patch` vs Card Kit streaming throughput/ceilings against a live app.
- schema 2.0 migration of the non-streaming card channel (only the streaming placeholder needs 2.0).

## Sources

- Card Kit streaming overview — https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
- Stream element text — https://open.feishu.cn/document/cardkit-v1/card-element/content
- Full card update — https://open.feishu.cn/document/cardkit-v1/card/update
- Partial (batch) card update — https://open.feishu.cn/document/cardkit-v1/card/batch_update
- Card JSON 2.0 release notes — https://open.feishu.cn/document/feishu-cards/card-json-v2-breaking-changes-release-notes
- im.message.patch (traditional) — https://open.feishu.cn/document/server-docs/im-v1/message-card/patch

Related #4208
