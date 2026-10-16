# Automatic compaction

For the Claude backend, the selected `agents.<name>.autoCompactWindow` controls
only the host override. Omitting it leaves the SDK's own settings and automatic
compaction behavior in control; it does not disable SDK compaction.

| Selected agent setting | Host behavior |
| --- | --- |
| Unset | No model metadata requests and no compaction settings injected |
| Positive integer | Inject that token trigger, without metadata discovery |
| `0` | Explicitly disable SDK automatic compaction |
| `auto` | Opt into bound-provider metadata discovery; native `claude-*` IDs keep SDK policy |

Discovery reads `max_input_tokens`, `context_length`, or `context_window` and
uses `floor(limit * 0.8)`. Output-only `max_tokens` is never a context limit.
Missing metadata produces a warning without injecting a guessed threshold.
Settings on another/default agent are not inherited by the selected named agent.

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

Other backends retain their own compaction policies; see
[dsh-backend.md](dsh-backend.md#context-compaction) for DSH.
