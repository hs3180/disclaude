# Independent agent tasks

`AgentTaskService` composes the scoped tool with service-owned admission. The
host supplies a current Project resolver, explicit permission predicate, runtime
selection and real channel callbacks. `createTool(queryCwd)` binds that query's
directory; each call requires the process-local provenance of an accepted Feishu
user input. JSON identity fields, push/REST inputs and changed source scope cannot
authorize a task. Permission and the current Project are checked before work and
again before returning its result.

One originating input retains its runtime, reply route and operation identities
across tool registrations in that service. Repeating the same operation shares
its real execution/result; another input has a separate namespace. Changing a
route, Project or an existing operation's work is refused. These identities are
not durable across a process restart: reconcile previous effects before issuing
new work after restart. Completed results do not establish Goal acceptance.

`isBusy(chatId)` includes native work and admitted callbacks; `close()` requests
cancellation and awaits actual settlement. Parent-tool cancellation stops only
the referenced child operation. Cross-round async questions are disabled for
these finite workers; a blocking question can still be handled while its query
is live.

The default service registers `run_agent_task` on Feishu Codex app-server chats.
Other transports and REST chats do not receive it. A system push in a Feishu
chat still cannot manufacture the required user provenance. When a host command
policy is installed, subtask admission checks its `steer` permission for the
actual user/chat/topic, in addition to the source and Project checks.

The child uses the chat/topic preset captured for that originating input. It
requests non-queuing capacity admission: if the LLM or native slots are occupied,
it reports failure without waiting behind a parent that needs its result. Normal
user messages retain their existing queueing behavior. Service shutdown drains
owned tasks before closing delivery channels; Project changes remain refused
while a subtask owns work or delivery. No Goal loop or board is required.

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
completion handle. A rejected logical turn on cancellation is not a delivery
receipt: the runner also waits for the query iterator and admitted asynchronous
callbacks (including RPC input delivery) to exit. `close()` rejects new starts, stops all owned tasks and waits
for their existing handles. Cancellation does not roll back external effects,
so inspect any partial result before an explicit retry.

The execution API and explicit host-tool adapter are independently testable.
Default service registration, a REST/CLI entry, durable task recovery and parent
wakeup remain integrations. They must preserve actual source authority, register
the owning runner with service shutdown and report each result once.

## Host tool adapter

`createAgentTaskTool(runner, binding)` supplies the backend-neutral
`run_agent_task` definition for a host to pass through `AgentQueryOptions.tools`.
Construct it for one authorized originating request with its actual source,
Project and delivery callbacks. These bindings are immutable for that instance;
do not reuse it for another source or derive identity from the model's arguments.
The host must also select a Harness/transport that supports business tools.

Arguments contain only `operationId`, `task` and a relative `workingDirectory`.
Canonical directory checks reject traversal and symlinks outside the bound
Project. The same operation ID and work reuse the existing completion handle;
changing work under that ID fails. Cancellation stops that operation, preserving
other operation IDs. Results are retained for this instance, up to 256 identities;
reaching the retention limit rejects new operations without evicting retry
evidence or cancelling work. This is a retention guard, not an execution budget.

The adapter awaits a result in the parent's tool call. It does not promise that
a finished parent can be woken later; that is F5. Retry identity is in memory,
not durable across service restart. Do not construct a fresh instance to replay
an uncertain external operation. Production tool registration still requires
trusted input binding and service lifetime wiring; nothing is auto-enabled by
importing the adapter.
