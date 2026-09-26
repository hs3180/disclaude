# Feishu CardKit streaming rate-limit benchmark

This procedure measures the live CardKit update behavior used to tune
`StreamingThrottle`. It is an operator-run experiment, not a CI test; the
benchmark prints a Markdown result table to stdout. Keep tenant-specific
results and credentials outside the repository.

## Preconditions

- A Feishu tenant access token with `cardkit:card:write` permission.
- A JSON 2.0 streaming card (`config.streaming_mode: true`) already sent to a
  chat, plus its card and element IDs.
- A test card whose visible updates may safely be changed during the run.

Do not use production content or commit access tokens. The benchmark sends live
updates to the selected card.

## Measurements

The runner performs a sustained-rate sweep, captures throttling/rejection
responses and `Retry-After`, measures the effective cooldown, and checks burst
tolerance. Element and card updates use `PUT`; finalize settings use `PATCH`.
The per-card `sequence` must increase monotonically across update operations.
The Feishu CLI wrapper may be too slow to reach the API's rate ceiling, so the
benchmark uses direct HTTP with a reusable tenant token.

Run the benchmark with:

```sh
LARKSUITE_CLI_TENANT_ACCESS_TOKEN=... \
CARDKIT_BENCH_CARD_ID=... \
CARDKIT_BENCH_ELEMENT_ID=... \
npx tsx scripts/feishu-cardkit-rate-limit-bench.mts
```

Optional cadence and duration settings use the `CARDKIT_BENCH_*` variables in
the script. Compare observations with the active defaults in
`packages/core/src/utils/streaming-throttle.ts` before changing them; a run on
one tenant is not a universal service limit.
