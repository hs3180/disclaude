# Empty-turn recovery contract

An empty turn has no user-visible output and no tool calls. For an eligible
real-user message, Disclaude may recover by resetting the chat session and
replaying the original input once. This is a bounded session-recovery path, not
a general retry for provider or channel errors.

## Eligibility and limit

- Synthetic messages, including scheduled-task and push/CLI messages, are never
  replayed; their IDs are not valid user-message reply roots.
- A chat receives at most one empty-turn replay until a non-empty turn resets
  its retry state. If the replay is also empty, no further attempt is made and
  the ordinary empty-turn notice is delivered.
- The empty turn is recorded as a failure even when a replay is scheduled. A
  retry is not treated as success before its result is known.

## Recovery sequence

1. Detect an empty result and check the message identity and per-chat retry
   limit.
2. Defer recovery until the current iterator has unwound, then close the old
   session and create a fresh one.
3. Best-effort refresh the bounded recent chat history. If refresh fails, replay
   the original message without the stale history snapshot.
4. Replay the original message once. Drop the replay if the agent was disposed
   or a newer message arrived before it could start.
5. Reset the retry state after a non-empty turn; otherwise report the empty
   result without attempting another replay.

This behavior is implemented by `EmptyTurnRetryPolicy` and `ChatAgent`. It is
distinct from the provider's in-place retry for transient API failures and from
the restart manager's repeated-failure circuit.
