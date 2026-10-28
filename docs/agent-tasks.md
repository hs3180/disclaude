# Independent agent tasks

`AgentTaskRunner` is a service-side building block for explicitly requested
subtasks. It works without a Goal loop or task board. The owning service supplies
the task, an existing absolute working directory, actual source chat/message/
actor context and the channel's delivery callbacks. The host remains responsible
for authorizing that task and directory; this API does not establish permission
from model-provided identity fields.

`start(request, callbacks)` returns a unique ID, `completion` and `stop()`. Each
execution uses a separate native session and skips persisted chat history. The
working directory and runtime configuration are captured before admission; a
missing directory fails rather than adopting the shared workspace. Normal
progress, files and questions use the supplied real channel callbacks and source
anchor. The runner does not replace those callbacks with successful no-ops.

Completion reports `succeeded`, `failed` or `stopped`, bounded terminal text and
its truncation state. It waits for actual turn settlement, completion callbacks
and explicitly reported native background continuations. A transport failure,
incomplete/truncated result or interrupted execution cannot become success.
Success describes execution, not acceptance of a Goal or approval of an artifact.
No automatic retries, runtime/token budget or elapsed-time watchdog is added.

Calling `stop()` requests cleanup of that execution only; await its existing
completion handle. `close()` rejects new starts, stops all owned tasks and waits
for their existing handles. Cancellation does not roll back external effects,
so inspect any partial result before an explicit retry.

This first step provides the independently testable execution API. It does not
yet expose a model tool, REST/CLI entry, durable task recovery or parent wakeup.
Those integrations must preserve actual source authority, register the owning
runner with service shutdown and report each result once.
