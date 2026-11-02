# Background task ownership

`BackgroundAgentTasks` is an explicit service-side owner for F5. Starting work
returns an ID/handle after host admission, without waiting for its result. The
parent turn may end while that service keeps owning the child. Each task has an
independent native identity, captured runtime, existing directory inside its
original Project, and the host's real delivery callbacks.

The host must authorize the captured request, supply actual channel callbacks,
and implement `wakeParent` with confirmed admission into the original parent
chat/topic. Identity strings in this API are not authentication. No model/REST
entry is enabled by the component alone. The same originating source and
operation ID share execution; a changed task, directory or reply route is refused.

Children may queue for capacity while their parent can finish independently.
The child's native turn result is its report: outcome and summary come from the
native result itself (no injected model face; a structured CLI report channel
may follow the #5603/#5611 pattern), and the artifact list stays empty until
that channel exists.
the host's actual settled native result determines success/failure/stopped.
Truncated output cannot become success. The result is persisted in
`TaskResultOutbox` before wakeup, and permission is checked again. A revoked
permission leaves the saved result pending; an unknown admission acknowledgement
remains uncertain and is not automatically retried. Partial artifacts survive
failed work. A wakeup receipt confirms host admission, not parent execution or
user-facing delivery.

Explicit stop suppresses future wakeup and requests child cancellation. Close
stops and drains owned work/delivery; it does not release ownership on a logical
cancel alone. A host can use `stopForParent` for explicit stop/reset, whereas a
normal parent turn ending does not cancel the child. Busy includes admission,
native work, persistence and parent notification.

Completed operation entries retain IDs/fingerprints rather than native runtime
objects. Retrying one reads its durable result without re-executing. The in-memory
operation index and unfinished workers are not automatically restored; the host
must reconcile its service interruption journal and previously issued task IDs
after restart. This component does not supply the default tool registration,
inbox deduplication, current-policy UI or final platform acceptance for F5.

## Default service wiring

The default service owns one `BackgroundAgentTasks` instance beside the agent
pool. Admission is Feishu-only and reuses current command policy, verified
source input and Project checks: the authorize port re-resolves the chat's
current Project binding and rejects when it no longer matches the admitted
root, or the acting source lost permission. REST/system inputs do not gain
user provenance. A child uses the runtime captured at admission; its original
parent chat/topic uses that parent's current selected runtime for the later
report.

Results are saved under the workspace's `.disclaude/tasks/results`. The parent
reporter awaits `processMessage` and checks `hasAdmittedInput`; an existing
completion can also represent refused input, so the ordinary fire-and-forget
system router is not an admission receipt. Reporting does not wait for parent
execution or claim platform delivery. Reports contain no manufactured user
identity or source capability, so they cannot independently authorize another
source-gated subtask.

Explicit parent stop/reset requests cancellation of its children; other topics
keep their work. Project busy checks include background ownership, and shutdown
drains children before closing the pool/channels. Unfinished jobs are not
automatically replayed after restart; reconcile the service interruption
journal and saved task IDs first. There is deliberately no injected model tool
face: the model-facing entry follows the disclaude CLI + built-in skill
pattern (#5603/#5611) and lands separately.
