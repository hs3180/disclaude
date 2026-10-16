# Claude retries, progress and usage estimates

The native SDK/client retries an API request within one execution. Host L1
recovery can only retry confirmed pre-launch failures: once a native process
starts, input is offered, or work becomes uncertain, #5361/#5369 block a new
execution. Consequently a failed native API request is not multiplied by the
host pre-launch budget.

The effective policy is resolved once for each host query and logged as
`claude_retry_policy`, including its generated `queryId`:

| Setting | Default | Accepted values | Scope |
| --- | --- | --- | --- |
| `DISCLAUDE_QUERY_MAX_RETRIES` | 2 | integer 0–15 | confirmed pre-launch failures |
| `CLAUDE_CODE_MAX_RETRIES` | 2 | integer 0–15 | native retries per API request, plus its initial request |
| `DISCLAUDE_RETRY_BACKOFF_BUDGET_MS` | 60000 | integer 0–1800000 | combined advertised retry waits per native result turn |

Selected query environment overrides the host environment. Invalid values fail
before spawning. The native retry count is pinned in SDK environment and flag
settings, so SDK default changes or project settings do not silently replace
it. Zero native retries disables API retry; zero wait budget denies positive
retry waits. A streaming session starts a fresh wait budget after each native
result, allowing later user turns to recover independently.

Before admitting a retry, the host reserves its advertised delay against the
shared wait budget. An unaffordable Retry-After is refused, rather than shortened
or ignored. Host pre-launch waits use the same budget. Native events exceeding
the configured retry cap or carrying invalid counters fail closed. Refusal
terminates the owned attempt, blocks outer replay and gives the user a budget
exhaustion notice. Ordinary accepted waits emit `claude_retry_progress` and a
chat notice with retry ordinal and estimated wait. These notices do not count
as answers and cannot hide an empty turn. Internal final-reply-only workflows
retain their normal output contract.

This is a retry-admission and advertised-wait budget, not a task-duration
watchdog. Productive model/tool execution and a slow initial response have no
new total duration cap. It does not claim a hard bound on all task HTTP calls:
productive tool rounds, subagents and auxiliary calls are distinct requests,
and some native helper calls do not expose retry progress. Teardown retains its
bounded exit confirmation. A controlled 60-second Retry-After with a 5-second
budget is rejected before the wait and exits in less than that budget after
the first API request; this is not an arbitrary production-outage guarantee.

Each attempt logs `claude_attempt_usage` with `queryId`, attempt ordinal,
`nativePid`, latency and available input/output/cache token counters and cost.
The final `claude_query_usage` includes every attempt and known subtotals.
Result metadata carries the same audit, linking ChatAgent's turn diagnostics
to the provider query. A host query may span multiple user turns in a streaming
session; do not sum its cumulative audit again at each turn.

Usage states are explicit:

- `reported`: the latest successful SDK result reports complete query-pipeline
  token counters, including SDK-reported subagent/sidechain coverage.
- `partial`: only main-loop counters or partial output are visible, the attempt
  failed/interrupted, fields are missing, or the SDK accounting window changed.
- `unknown`: no usable token report, including zeroed crash/startup-error data.
  Missing counters are omitted. Unknown attempts never become zero charges in
  `knownTotals`; `unknownAttempts`/`partialAttempts` remain alongside subtotals.

Prefer `modelUsage`: it and `total_cost_usd` are cumulative within the SDK
query, so newer result snapshots replace earlier ones. The main-loop `usage`
fallback is per native result turn; repeated assistant message/result IDs are
deduplicated, and later partial main-loop output remains visible after an
earlier complete turn. A native conversation reset can change its accounting
window: the current snapshot is marked partial rather than claimed to cover
all earlier windows. SDK helper calls outside its query pipeline and upstream
requests whose response was lost may remain unobserved. All costs are SDK
estimates with `billingVerified: false`, not upstream invoices. Physical POST
counts do not prove duplicate billing.

Reproduce without channel connections or external inference:

```sh
pnpm run build
pnpm exec vitest run packages/core/src/sdk/providers/claude/retry-budget.test.ts packages/core/src/sdk/providers/claude/attempt-usage.test.ts packages/core/src/sdk/providers/claude/provider.test.ts packages/core/src/sdk/providers/claude/message-adapter.test.ts packages/service/src/agents/chat-agent.test.ts
node tests/integration/claude-retry-budget.mjs
node tests/integration/claude-attempt-exit.mjs
```

The three-attempt provider fixture has two unknown pre-launch failures and a
reported successful attempt. The separate ledger fixture includes visible
partial failed-attempt usage, an unknown attempt and a reported success. A
native attempt with observed work is never replayed merely to produce an
accounting fixture. Existing virtual-time coverage keeps a productive task
alive past 180 seconds with an explicitly sufficient retry-wait budget.
