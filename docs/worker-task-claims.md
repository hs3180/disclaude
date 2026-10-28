# Host-bound worker claims

`createWorkerTaskClaims` adapts the single-service `TaskClaimStore` for a managed
worker. The owning service supplies its actual native execution ID, physical
completion promise, canonical allowed task coordinates and a current
task/Project permission check. An owner string in model input grants no rights.
Bind each new execution once; do not reuse a worker ID after service restart.

Register its `board_task_claim` tool only on that worker's query. The model can
read an allowed task or claim its current revision. It cannot supply a resource
path, worker identity, claim secret, Project or release action. A successful
claim must precede any work; an error or unknown acknowledgement grants no
permission to begin. The host retains a stable private attempt before writing,
so an exact retry can reconcile an acknowledgement lost after commit.

The host explicitly calls `release(taskId)` after reconciling the execution. It
waits for the supplied physical completion promise before releasing the exact
lease, including when the original claim's acknowledgement was lost. Completion
must cover native iteration, background work and delivery callbacks, as the
existing `AgentTaskHandle.completion` contract does. No release is automatic on
failure, timeout, cancellation or restart; older releases cannot free a later
owner. Use a new worker binding for a new attempt. Revoked permission retains
the claim for authorized reconciliation.

This adapter neither starts a worker nor asserts that Base has accepted a
projection. The default service must bind actual handles and current authority;
Base owner/status publication and its acknowledgement need separate integration.
It is not a cross-process lock. Keep all workers on the same owning service and
retain held claims across restart rather than replaying unknown effects.
