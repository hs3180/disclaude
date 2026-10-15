# Automatic compaction

For the Claude backend, disclaude resolves the compaction policy in this order:

1. If `agents.<name>.autoCompactWindow` is configured, use that value without querying
   model metadata. This applies to native Claude models as well as compatible
   third-party models. `0` disables SDK automatic compaction.
2. When unset, do not query model metadata or inject compaction settings. All
   models retain the SDK's native strategy, including compatible third-party models.
3. Set `autoCompactWindow: auto` to opt into metadata discovery. Native `claude-*`
   IDs retain SDK policy. For other IDs, query only the bound provider's models API
   and use `floor(limit * 0.8)`. Read `max_input_tokens`, `context_length`, or
   `context_window`; output-only `max_tokens` is never a context limit. Missing
   metadata produces a warning without injecting a guessed threshold.

```yaml
agents:
  assistant:
    backend: claude
    llm: assistant
    autoCompactWindow: 80000
# Define llms.assistant as shown in agent-configuration.md.
```

Discovery uses the configured API origin and credentials, not a third-party
catalog. It tries model detail, then the model list, matching the exact ID.
Root Anthropic endpoints use `/v1/models`; versioned/custom base paths are
preserved. An `/anthropic` compatibility suffix uses the corresponding
OpenAI-style `/models` endpoint. Redirects are not followed with credentials.
The total lookup deadline is five seconds. Positive results are cached for
five minutes, missing results for 30 seconds, scoped by endpoint/model/credential.
Cancelling a stream during lookup prevents SDK subprocess startup.

Compaction is checked by the SDK at conversation boundaries. Neither an
explicit nor an API-derived threshold guarantees acceptance of an arbitrarily
large single input. Native SDK runtime limits can also be smaller than a
third-party model's advertised context capacity.

If a request exceeds a compatible model's limit, inspect partial results before
continuing with less input or starting a fresh session with `/reset`. Disclaude
never replays tools to recover context. Explicit compaction changes conversation
history and should be an operator choice.

Codex and pi retain their own compaction policies. DSH standard supports the
native policy described in [dsh-backend.md](dsh-backend.md#context-compaction);
DSH minimal never mounts compaction plugins.
