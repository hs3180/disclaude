# Claude API error classification

`tagErrorCategory` is shared by retryability checks and the restart manager.
It retains `category`, `transient`, and an optional HTTP `status`. Structured
evidence reports `source: structured`.

The classifier prefers explicit `AppError` policy, then `apiErrorStatus`,
`status`, `statusCode`, or `response.status` on the error or its bounded cause
chain. An explicit boolean `apiErrorIsTransient` takes precedence over status
and message wording. For example, a final SDK `429` with
`apiErrorIsTransient: false` is an API failure that cannot trigger a transient
retry. Ports and IDs such as `15020` or `429123` do not supply HTTP status.

For terminal results, the Claude provider prefers structured stream fields,
then API-error records from the SDK-owned main session's local transcript.
It uses the observed session ID, configured Claude directory and attempt start
time; it reads no other session content. The append cursor skips historical
records, sidechains and recovered API errors. It keeps byte offsets across
partial UTF-8 writes and does not put transcript bodies in result metadata.
Ambiguous session files and unreadable data leave the transcript source
unavailable. Legacy stderr signatures are used when structured evidence is
unavailable.

The SDK may emit its terminal before its local transcript write settles.
Diagnostics allow up to 500 ms for that local flush, including failed API
terminals. This is a terminal diagnostic wait, not a task-duration limit.
`upstreamApiErrorSource`, `upstreamApiErrorStatus` and
`upstreamApiErrorIsTransient` describe the evidence used. A subsequent SDK
throw retains the immediately preceding terminal's structured verdict.

After installing this checkout's dependencies:

```sh
pnpm run build
pnpm exec vitest run packages/core/src/utils/error-handler.test.ts packages/core/src/agents/restart-manager.test.ts packages/core/src/sdk/providers/claude/api-error-evidence.test.ts packages/core/src/sdk/providers/claude/provider.test.ts
node tests/integration/claude-structured-api-error.mjs
```

The integration fixture uses the installed native Claude SDK against an owned
loopback HTTP 429 endpoint. It prints the actual HTTP requests, terminal
metadata and classification source. It performs no external model inference
and opens no channel connection. Process teardown and replay admission are
tracked separately in #5361 and #5369.
