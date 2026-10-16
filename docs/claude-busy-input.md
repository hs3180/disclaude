# Messages while an agent is busy

Named agents accept `busyInput: steer | stream | queue`; omission means `steer`.

| Policy            | Claude                                                                                                       | Codex app-server                                                     | Other transports                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------- |
| `steer` (default) | Acknowledge native interrupt, finish the old input as interrupted, then submit the new input as its own turn | Native same-turn steer and ACK; the input shares its owner's outcome | Fall back to the transport's input stream or queue |
| `stream`          | Inject into the existing input stream; in-flight tools continue                                              | No steer RPC; normal channel input uses the transport's queue        | Use the transport's normal input stream or queue   |
| `queue`           | Hold the input in a host FIFO until the current turn ends                                                    | Hold until the current turn ends                                     | Hold until the current turn ends                   |

For example:

```yaml
agents:
  assistant:
    backend: claude
    llm: assistant
    busyInput: steer
```

Claude replacement steering retains the same native query, process and session.
The host submits the new input only after the SDK interrupt acknowledgement and
its old input's actual terminal result. Its completion and reply anchor belong
to the new input. Concurrent admissions retain their arrival order. An old turn
that finishes naturally while interrupt is pending keeps its real outcome; the
replacement still receives its own turn. Neither path replays the old input.

The SDK emits an interruption marker followed by an `error_during_execution`
result for a cancelled tool. The adapter recognizes a control interruption only
when the interrupt was acknowledged, the result identifies that input's UUID,
and the native user-interruption marker was observed. Unrelated errors retain
their failure classification. The user receives one short interruption notice
for the old turn; final-reply-only callers suppress that notice.

If native interrupt is unavailable or rejected, the new input has not been sent
by the provider, so it may be submitted once through the existing stream or
queue. The notice describes the actual fallback. Stream injection does not stop
in-flight tools. Admission is bounded to 50 unfinished inputs, including the running turn; a full queue
rejects the new message instead of claiming it was accepted.

`/steer <instruction>` explicitly requests native steering regardless of the
normal busy-input policy. `/stop` still cancels the current agent execution and
confirms native cleanup. Neither command automatically interrupts a remote
Jupyter execution; that run has its own explicit Jupyter interrupt operation.
Stopping an agent also does not undo external side effects that already happened.

The installed-SDK regression uses an owned HTTP endpoint and a local Bash tool:

```sh
pnpm run build
node tests/integration/claude-interrupt-steer.mjs
```

It checks native interrupt acknowledgement, a correlated interrupted terminal,
a live iterator, the next input's successful response, tool cancellation and
absence of input replay. It makes no external inference request or channel
connection. Real Claude/Feishu dogfood is a separate acceptance gate.
