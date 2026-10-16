# Claude retries and usage

Each logical Claude query creates one SDK query and one native execution.
Disclaude never replays the whole query. API retries, retry configuration and
backoff waits belong to the agent framework; the host does not impose a retry
budget or turn native retry events into chat notices.

Native result messages provide the single usage source, including failed
results. The adapter prefers `modelUsage` pipeline counters over main-loop
`usage`, retains input/output/cache tokens and SDK-reported cost, and validates
that counters are finite and nonnegative. Each result is a snapshot; subsequent
results replace previous counters rather than adding cumulative values.
The provider logs the latest reported snapshot once when the query closes.
Missing usage stays absent. These SDK reports are not verified billing data.

Reproduce with local owned endpoints and no external inference:

```sh
pnpm run build
node tests/integration/claude-sdk-owned-retries.mjs
node tests/integration/claude-attempt-exit.mjs
```
