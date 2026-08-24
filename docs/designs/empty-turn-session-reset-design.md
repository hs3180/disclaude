# Empty-Turn Session-Reset + Replay Design Document

**Status:** Draft / Proposal (for discussion — not an implementation contract)
**Issue:** #4391 (`enhancement(chat-agent): auto session-reset + bounded retry on empty turn`, #4194 follow-up ②)
**Related:** #4194 (the empty-turn symptom), #4258 (parts ①③④ landed), #4259 (sched-* reply-root), #4166 (synthetic-id registry), #4314 (transient-error in-place replay — different concern)

> This document proposes the **session-lifecycle design** that #4391 / #4258
> repeatedly deferred as the prerequisite to wiring the reset/replay mechanism.
> The eligibility + bounding contract is already locked in
> `EmptyTurnRetryPolicy` (`packages/core/src/agents/empty-turn-retry-policy.ts`);
> this doc specifies how the ChatAgent consumes it.

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
| Session reset | `callbacks.resetAgent(chatId, skipContext=true)` — declared `scheduler.ts:136`, wired `primary-node.ts:936` → `agentPool.reset(chatId, true)` |
| Eligibility + bounding | `EmptyTurnRetryPolicy` (`packages/core/src/agents/empty-turn-retry-policy.ts`) — `canRetry` / `markRetried` / `reset`, already exported from `packages/core/src/index.ts` |

`EmptyTurnRetryPolicy` is complete and has no caller yet ("No caller wires this yet" —
its docstring). The implementation work is: instantiate one policy per ChatAgent (or
per chat via the agent pool), stash the original `UserMessageParams` for the in-flight
turn, and add the branch above.

---

## 4. Design decisions

1. **v1 replays only the single user message — NO history re-injection.**
   `resetAgent(chatId, true)` yields a fresh session; the replay re-sends only the
   original user message. Rationale: the simplest choice that removes the manual
   resend, and the original message alone is usually sufficient for a non-empty retry.
   Re-injecting recent history is a strictly harder problem (how much, dedup vs. the
   message being replayed, cost) and is explicitly deferred (see §6).

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

- **History re-injection depth** — ~~v1 does none. Follow-up: optionally re-inject the
  last N real user messages into the fresh session so the retry does not lose context.
  Needs a decision on N and on dedup vs. the replayed message.~~ **Delivered** (2026-08):
  the replay's deferred callback now calls `HistoryManager.reloadFirstMessageHistory()`
  before the teardown, re-stashing the recent chat history (via `getChatHistory`, same
  source and truncation as the first-message load) so the replayed message — the fresh
  session's first — consumes it through the existing consume-once path. What v1 lost was
  not ALL context (the session-start `persistedHistoryContext` snapshot rode every
  message, teardown included) but FRESHNESS: turns logged after that snapshot. Depth
  decision: reuse the first-message budget rather than a new N (one knob, one truncation
  owner); no dedup needed — the replayed message appearing in the history tail mirrors
  what a manual user resend produces today. Best-effort: fetch failure or `--no-context`
  (`skipHistory`) skips re-injection and the replay falls back to the v1 param (a
  trigger-mode mention's receive-time snapshot, or context-less otherwise); guards
  (disposed / messageSeq) are re-checked after the fetch's await. **Param precedence
  follow-up**: `processMessage` prefers an incoming `chatHistoryContext` param over the
  stash, and trigger-mode @mentions carry one — so on a successful re-injection the
  replay passes a COPY of the original params with that stale param stripped (copy, not
  mutate: the stash object is `lastTurnMessage` by reference), letting the fresh fetch
  win and keeping the consume-once semantics (the stash can no longer leak onto a later
  param-less message).
- **Where to stash original `UserMessageParams`** for the in-flight turn (instance field
  vs. threading through `processIterator`). Minor; pick whatever the codebase finds
  least intrusive. *(Resolved in part 2: instance field `lastTurnMessage`.)*
- **Reset/replay for non-real-user-but-non-synthetic** messages (if any exist between
  "real user" and the `isSyntheticMessageId` set) — confirm the policy's eligibility
  covers exactly the intended set.
- Out of scope: in-place replay of transient API errors (#4314, done); `sched-*`
  reply-root 400 (#4259, done); remaining empty-turn regression coverage (#4260).

---

## 7. PR index

- _EmptyTurnRetryPolicy (prerequisite)_ — already on main (`packages/core/src/agents/empty-turn-retry-policy.ts`).
- _Wiring PR (reset + replay in ChatAgent)_ — TBD, to follow this design after sign-off.
