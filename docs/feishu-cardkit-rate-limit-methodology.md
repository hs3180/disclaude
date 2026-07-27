# Card Kit PATCH rate-limit — characterization methodology (#4398)

> Status: **methodology + bench design only.** The measured numbers are TBD —
> characterization requires a live Feishu tenant (a `tenant_access_token` + a
> streaming card to PATCH). This doc lands the measurement plan and the
> parameters it feeds, so the throttle defaults (currently educated guesses)
> have a clear path to being tuned from real data.
>
#4398 / #4208 P1-c. Complements the #4238 streaming research and feeds the
#4414 `StreamingThrottle` + #4399 state machine.

## Why

Native streaming PATCHes (`PATCH /cardkit/v1/cards/{card_id}/elements/{element_id}/content`,
confirmed by #4238) arrive faster than the Card Kit rate limit allows. The
`StreamingThrottle` (#4414) batches them, but its defaults are guesses:

| `StreamingThrottle` param | current default | should come from |
|---|---|---|
| `minIntervalMs` | **200 ms** (5 PATCH/s) | the sustained PATCH/s before 429 |
| `maxBackoffMs` | **8000 ms** | the observed max 429 cooldown |
| backoff multiplier (`note429`) | doubles (uncapped → `maxBackoffMs`) | the API's `Retry-After` behavior |

This doc defines how to measure those three so the defaults stop being guesses.

## What to measure

1. **Sustained PATCH/s before 429.** The steady-state rate the Card Kit
   accepts without throttling. Drives `minIntervalMs = 1000 / (sustained PATCH/s)`.
2. **429 backoff behavior.** When the rate is exceeded, how does the API
   signal the wait? A `Retry-After` header (seconds)? A cooldown window? An
   error code + message? Drives the backoff multiplier + `maxBackoffMs`.
3. **Leading/trailing (burst) tolerance.** Does the API smooth short bursts
   (e.g. 5 PATCHes in 100ms then idle) or throttle each one? Determines
   whether the throttle's leading+trailing window is the right shape (#4414).

## Bench approach

**Preconditions** (the reason this is TBD — none are available from CI):
- A live Feishu tenant: `LARKSUITE_CLI_TENANT_ACCESS_TOKEN` set.
- A streaming card to PATCH: create a JSON-2.0 card with
  `config.streaming_mode = true` (the #4395 client's createCard / message-send
  path) → obtain `card_id`; pick an `element_id` (e.g. `STREAMING_REPLY_ELEMENT_ID` from #4396).
- The `FeishuCardKitClient` (#4395) wired, OR a standalone `fetch` loop hitting
  the PATCH endpoint directly.

**Procedure:**
1. **Sustained rate sweep.** Send incremental `patchElementContent` calls at a
   fixed cadence (start at 2/s, ramp to 10/s, 20/s…). Record the cadence at
   which the first 429 appears and the success/fail count at each step.
2. **429 capture.** On each 429, log the response: status, body (`code`/`msg`),
   and **any `Retry-After` header**. Note the time until the next non-429 PATCH
   succeeds (the effective cooldown).
3. **Burst test.** Send a tight burst of N PATCHes (e.g. 10 in 50ms), then go
   idle for 1s, repeat. Observe whether the burst is smoothed (all eventually
   applied) or dropped/throttled.

## Findings (TBD — fill after a live run)

| Metric | Value | Source |
|---|---|---|
| Sustained PATCH/s before 429 | _TBD_ | rate sweep |
| `Retry-After` present? (yes/no) | _TBD_ | 429 capture |
| Effective 429 cooldown (ms) | _TBD_ | 429 capture |
| Burst tolerance | _TBD_ | burst test |
| → recommended `minIntervalMs` | _TBD_ | `1000 / sustained` |
| → recommended `maxBackoffMs` | _TBD_ | observed max cooldown |

## Once measured

Update `StreamingThrottle` defaults in `packages/core/src/utils/streaming-throttle.ts`
(#4414) and document the chosen values here. The throttle's `note429` multiplier
stays "double, capped at `maxBackoffMs`" unless the bench shows the API's
`Retry-After` demands a different curve.

## Scope / dependencies

This is the methodology half of #4398. The actual bench run + measured numbers
need #4395 (client) + #4396 (builder) merged and a live Feishu integration —
tracked separately. Filing the methodology now so the throttle defaults have a
documented tuning path rather than remaining silent guesses.

Related: #4398, #4208 (P1-c), #4238, #4414, #4399.
