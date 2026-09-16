# Card Kit streaming-update rate-limit — characterization methodology (#4398)

> Status: **methodology + bench design only.** Most measured numbers are TBD —
> characterizing the rate ceiling needs a direct-HTTP ramp past ~5 updates/s
> (see Findings). This doc lands the measurement plan and the parameters it
> feeds, so the throttle defaults (currently educated guesses) have a clear
> path to being tuned from real data.
>
> #4398 / #4208 P1-c. Feeds the #4414 `StreamingThrottle` + #4399 state machine.
>
> **Endpoint correction (verified live 2026-07-28):** the streaming updates this
> doc rates are **PUT**, not PATCH —
> `PUT /cardkit/v1/cards/{card_id}/elements/{element_id}/content` for element
> content, and `PUT /cardkit/v1/cards/{card_id}` for a full-card replace. PATCH
> on those paths returns a gateway **404**. Only the finalize call,
> `PATCH /cardkit/v1/cards/{card_id}/settings`, is actually PATCH. The earlier
> "#4238 confirms PATCH" anchor is doubly broken: #4238 was reverted (its
> research doc is 404 on `main`) **and** the method it confirms is wrong. The
> corrected client lives in #4411, fixed to PUT (+ `sequence`, + finalize) in #4418.

## Why

Native streaming updates (`PUT /cardkit/v1/cards/{card_id}/elements/{element_id}/content`,
each carrying a per-card monotonic `sequence`) arrive faster than the Card Kit
rate limit allows. The `StreamingThrottle` (#4414) batches them, but its defaults
are guesses:

| `StreamingThrottle` param | current default | should come from |
|---|---|---|
| `minIntervalMs` | **200 ms** (~5 updates/s) | the sustained updates/s before 429 |
| `maxBackoffMs` | **8000 ms** | the observed max 429 cooldown |
| backoff multiplier (`note429`) | doubles (uncapped → `maxBackoffMs`) | the API's `Retry-After` behavior |

This doc defines how to measure those three so the defaults stop being guesses.

## What to measure

1. **Sustained updates/s before 429.** The steady-state rate the Card Kit
   accepts without throttling. Drives `minIntervalMs = 1000 / (sustained/s)`.
2. **429 backoff behavior.** When the rate is exceeded, how does the API
   signal the wait? A `Retry-After` header (seconds)? A cooldown window? An
   error code + message? Drives the backoff multiplier + `maxBackoffMs`.
3. **Leading/trailing (burst) tolerance.** Does the API smooth short bursts
   (e.g. 5 updates in 100ms then idle) or throttle each one? Determines
   whether the throttle's leading+trailing window is the right shape (#4414).

## Bench approach

**Preconditions** (the reason the ceiling is TBD — not all available from CI):
- A live Feishu tenant: `LARKSUITE_CLI_TENANT_ACCESS_TOKEN` set, with
  `cardkit:card:write` enabled (the scope is now open on the app).
- A streaming card to update: create a JSON-2.0 card with
  `config.streaming_mode = true` → obtain `card_id`; pick an `element_id`
  (e.g. `STREAMING_REPLY_ELEMENT_ID` from #4396). Send it to a chat via
  `POST /im/v1/messages` (`msg_type: interactive`,
  content `{type:'card',data:{card_id}}`).
- The corrected `FeishuCardKitClient` (#4411, fixed to PUT in #4418) wired,
  OR a standalone `fetch` loop hitting the **PUT** endpoint directly. Note:
  the `lark-cli` wrapper tops out near ~2 calls/s, so reaching the ceiling
  requires direct HTTP with a reusable token.

**Procedure:**
1. **Sustained rate sweep.** Send incremental `updateElementContent` calls
   (**PUT**) at a fixed cadence (start at 2/s, ramp to 10/s, 20/s…), **each
   carrying the next per-card `sequence`** — `sequence` is shared across PUT
   content / PUT card / PATCH settings; out-of-order or reused values are
   rejected with code **300317**. Record the cadence at which the first 429
   appears and the success/fail count at each step.
2. **429 capture.** On each 429, log the response: status, body (`code`/`msg`),
   and **any `Retry-After` header**. Note the time until the next non-429
   update succeeds (the effective cooldown).
3. **Burst test.** Send a tight burst of N PUTs (e.g. 10 in 50ms — `sequence`
   still monotonic), then go idle for 1s, repeat. Observe whether the burst is
   smoothed (all eventually applied) or dropped/throttled.

## Findings

| Metric | Value | Source |
|---|---|---|
| Sustained updates/s before 429 | **≥ 1.7/s (lower bound)** — 265 incremental PUTs, 0 rejections | live `glm-5.2` stream, 2026-07-28 |
| Rate at which 429 begins (ceiling) | _TBD_ — needs direct-HTTP ramp past ~5/s | rate sweep |
| `Retry-After` present? (yes/no) | _TBD_ (no 429 observed yet) | 429 capture |
| Effective 429 cooldown (ms) | _TBD_ | 429 capture |
| Burst tolerance | _TBD_ | burst test |
| → recommended `minIntervalMs` | _TBD_ (200 ms / 5-s guess is safe so far) | `1000 / sustained` |
| → recommended `maxBackoffMs` | _TBD_ | observed max cooldown |

> The ≥1.7/s figure was measured CLI-bound (per-call `lark-cli` overhead), so it
> only proves the API does not throttle at low sustained rates — it does **not**
> confirm 5/s is the ceiling. Confirming the ceiling needs a reusable-token
> direct-HTTP ramp (the CLI can't spawn fast enough to get there).

## Once measured

Update `StreamingThrottle` defaults in `packages/core/src/utils/streaming-throttle.ts`
(#4414) and document the chosen values here. The throttle's `note429` multiplier
stays "double, capped at `maxBackoffMs`" unless the bench shows the API's
`Retry-After` demands a different curve.

## Scope / dependencies

This is the methodology half of #4398. The actual ceiling measurement needs:
the corrected client (#4411, PUT fix in #4418) + a reusable tenant token for
direct-HTTP ramp; the card builder (#4396) is still open. Filing the methodology
now so the throttle defaults have a documented tuning path rather than remaining
silent guesses.

Related: #4398, #4208 (P1-c), #4411, #4418, #4414, #4399. (#4238 was reverted;
its streaming-research doc is 404 on `main` — do not anchor on it.)
