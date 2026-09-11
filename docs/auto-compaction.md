# Automatic compaction

For the Claude backend, disclaude resolves the compaction policy in this order:

1. If `agent.autoCompactWindow` is configured, use that value without querying
   model metadata. This applies to native Claude models as well as compatible
   third-party models. `0` disables SDK automatic compaction.
2. Native `claude-*` model IDs retain the SDK's automatic policy without a
   discovery override. Otherwise, query the configured provider's models API.
   Read `max_input_tokens`, `context_length`, or `context_window`, then use
   `floor(limit * 0.8)` to reserve 20% for output and growth between checks.
   Output-only `max_tokens` is never treated as a context limit.
3. If the API does not expose a valid limit, log a warning asking for explicit
   configuration. Do not inject a fixed/guessed threshold; the underlying SDK's
   behavior remains unchanged. This does **not** guarantee safe compaction for
   an unknown model, so configure a threshold when discovery is unavailable.

```yaml
agent:
  agentBackend: claude
  # Optional explicit override; choose based on your model/runtime limits.
  autoCompactWindow: 80000
```

Discovery uses the configured API origin and credentials, not a third-party
catalog. It tries model detail, then the model list, matching the exact ID.
Root Anthropic endpoints use `/v1/models`; versioned/custom base paths are
preserved. An `/anthropic` compatibility suffix uses the corresponding
OpenAI-style `/models` endpoint. Redirects are not followed with credentials.
The total lookup deadline is five seconds. Positive results are cached for
five minutes, missing results for 30 seconds, scoped by endpoint/model/credential.
Cancelling a stream during lookup prevents SDK subprocess startup.

On 2026-09-11, a live DeepSeek `/models` request returned model IDs and ownership
only, without context limits. Discovery therefore deliberately returned no
override. Set the threshold explicitly for that API until it exposes metadata;
do not infer a limit from an unrelated model or a static model-name table.

Compaction is checked by the SDK at conversation boundaries. Neither an
explicit nor an API-derived threshold guarantees acceptance of an arbitrarily
large single input. Native SDK runtime limits can also be smaller than a
third-party model's advertised context capacity.

Other backends retain their own compaction policies; this setting is not passed
to Codex, pi, or the native DeepSeek harness.
