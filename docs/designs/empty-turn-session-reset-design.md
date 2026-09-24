# Empty-Turn Session-Reset + Replay Design Document

**Status:** Implemented design contract
**Issue:** #4391 (`enhancement(chat-agent): auto session-reset + bounded retry on empty turn`, #4194 follow-up ②)
**Related:** #4194 (the empty-turn symptom), #4258 (parts ①③④ landed), #4259 (sched-* reply-root), #4166 (synthetic-id registry), #4314 (transient-error in-place replay — different concern)

> This document records the current **session-lifecycle contract** for the
> implemented reset/replay mechanism. The eligibility and bounding contract
> lives in `EmptyTurnRetryPolicy`; `ChatAgent` owns the one-shot reset,
> replay, and optional fresh-history re-injection.

---

## 1. Overview

### Problem

When a real-user turn completes with **no user-visible output and no tool calls**
(an "empty turn" — `userVisibleOutputCount === 0 && toolCallCount === 0`,
detected at `chat-agent.ts:1133`), the bot appears to ignore the user. The
already-landed corrective actions are:

- ④ structured warn — #4213 / #4246
- ① diagnostic ⚠️ user notice — #4262 (sent at `chat-agent.ts:1170`)
- ③ mark the turn as failed — #4290 (`recordFailure('empty-turn')` at `chat-agent.ts:1283`,
  no longer `recordSuccess`)

What is **still missing** (this issue, ②): the bot does **not** self-heal — the user
must manually resend to get a fresh turn. An empty turn's root cause is typically a
**stale / corrupted persistent session** (cf. the original #4194 report:
`messageCount 362+`), so in-place replay against the same session (the #4314 approach
for transient API errors) would very likely produce another empty turn. The fix is to
**reset to a fresh ChatAgent session and replay the user's input exactly once**.

### Why it was deferred

`chat-agent.ts:1129` and `:1269`, and the `EmptyTurnRetryPolicy` docstring, all mark
reset/replay as "needs session-lifecycle design". The policy was extracted first
precisely so the eligibility/bounding rules could land and be reviewed in isolation.
This document is the remaining design.

---

## 2. Mechanism (proposed)

On a real-user empty turn, the ChatAgent:

1. **Checks eligibility + bounding** via `EmptyTurnRetryPolicy.canRetry(chatId, openMessageId, isEmptyTurn)`.
   - Returns `false` for non-empty turns, for synthetic messages (`sched-*`, `push_*`,
     `cli-*`, … via `isSyntheticMessageId`), and for chats that already used their one retry.
2. If eligible: **`markRetried(chatId)`**, **reset the session**, **replay the input once**.
3. If the retried turn is **non-empty**: `recordSuccess` + `retryPolicy.reset(chatId)` (future empty turns can retry again).
4. If the retried turn is **still empty**: no further retry (bounded to 1) → fall back to the existing ① ⚠️ notice + ③ `recordFailure('empty-turn')`.

```
processIterator result
        │
   isEmptyTurn? ── no ──▶ recordSuccess, retryPolicy.reset(chatId)   (normal path)
        │ yes
   canRetry(chatId, openMessageId, isEmptyTurn)? ── no ──▶ ⚠️ notice + recordFailure (current behavior)
        │ yes
   markRetried(chatId)
   resetAgent(chatId, skipContext=true)         // fresh ChatAgent for the chatId
   schedule: processMessage(originalParams)     // replay, AFTER current turn unwinds
        │
   (replayed turn is itself subject to empty-turn detection,
    but canRetry now returns false → bounded to 1)
```

The replay is **scheduled for after the current turn unwinds**, not a synchronous
re-entry into `processIterator` (which would recurse on the turn-completion path).
A pending-replay flag + the stashed original `UserMessageParams` drive a single
re-invocation of `processMessage` once `processIterator` settles and `resolveTurn()`
fires (`chat-agent.ts:1294`).

---

## 3. Hook points (code references, current main)

| Concern | Location |
|---|---|
| Turn entry / replay vector | `ChatAgent.processMessage({ chatId, payload, messageId, senderOpenId })` — `chat-agent.ts:546` (public; replay = re-invoke with original params) |
| Empty-turn detection | `isEmptyTurn` — `chat-agent.ts:1133` (in `processIterator` result handling) |
| Diagnostic ⚠️ notice (to suppress on a retrying attempt) | `chat-agent.ts:1147`–`1188` |
| Failure accounting | `restartManager.recordFailure(chatId, 'empty-turn')` — `chat-agent.ts:1283` |
| Turn-completion gate (replay trigger) | `this.resolveTurn()` — `chat-agent.ts:1294` |
| Session reset | `callbacks.resetAgent(chatId, skipContext=true)` — declared `scheduler.ts:136`, wired `service.ts:936` → `agentPool.reset(chatId, true)` |
| Eligibility + bounding | `EmptyTurnRetryPolicy` (`packages/core/src/agents/empty-turn-retry-policy.ts`) — `canRetry` / `markRetried` / `reset`, already exported from `packages/core/src/index.ts` |

`ChatAgent` instantiates one policy, stashes the current
`UserMessageParams`, and schedules a guarded reset/replay. A monotonically
increasing message sequence prevents an older replay from overtaking newer
input. `HistoryManager` may refresh the bounded first-message history before
the replay; failures fall back to the original message without creating a
second retry path.

---

## 4. Design decisions

1. **Replay resets the session and reuses the original user message.**
   `resetAgent(chatId, true)` yields a fresh session. Before the replay,
   `HistoryManager` best-effort reloads the bounded first-message history so
   the fresh session does not lose recent context; a reload failure falls back
   to the original message.

2. **Bounded to exactly one retry per chat per window** — via `EmptyTurnRetryPolicy`
   (the `retriedChats` set). A second consecutive empty turn gets no retry.

3. **Synthetic (`sched-*`) turns are never retried** — the policy excludes them via
   `isSyntheticMessageId` (#4166), so replaying can never hit the invalid-reply-root
   400 that #4259 fixed.

4. **`EmptyTurnRetryPolicy` is separate from `restartManager`** — intentionally, per
   the policy docstring. `restartManager` remains the chronic-failure circuit
   (`maxRestarts`, trips after repeated failures, does NOT auto-restart on its own);
   the retry policy is the single-shot empty-turn self-heal. No parallel "retry counter"
   is introduced.

5. **No double-accounting / double-notify.** On the retrying attempt the ⚠️ empty-turn
   notice is suppressed (we are actively recovering); it is sent only if the retried
   turn is *also* empty. The retried turn's outcome is recorded normally
   (`recordSuccess` or `recordFailure`).

---

## 5. Regression test matrix

- real-user turn → empty → **one** reset + replay → non-empty → `recordSuccess`, `retryPolicy.reset(chatId)`.
- real-user turn → empty → retry → **also empty** → no 3rd attempt; ⚠️ notice sent; `recordFailure('empty-turn')`.
- `sched-*` (synthetic) empty turn → **no retry** (no resetAgent call, no replay).
- chat already used its retry → 2nd empty turn → **no retry** (bounded).
- retry path does not call `recordSuccess` while still empty (acceptance criterion).

---

## 6. Open questions / out of scope

- History re-injection is bounded by the existing first-message budget; it does
  not introduce a second history limit.
- Replay is skipped for synthetic IDs and for a disposed agent or superseded
  message sequence.
- In-place replay of transient API errors remains a separate mechanism.

---

## 7. PR index

- `EmptyTurnRetryPolicy` — `packages/core/src/agents/empty-turn-retry-policy.ts`.
- Reset/replay wiring — `packages/service/src/agents/chat-agent.ts`.
- History refresh — `packages/service/src/agents/history-manager.ts`.
