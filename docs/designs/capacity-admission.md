# Capacity admission for dependent work

Ordinary user queries retain the existing FIFO admission policy. A host that is
synchronously awaiting a child query can set `AgentQueryOptions.capacityAdmission`
to `reject`. If the named LLM, Codex run or app-server session capacity is busy,
that child fails admission without joining the queue or launching native work.
The parent remains owned and can inspect the failure or choose other work.

This prevents a child from waiting behind the parent that needs its result to
release a slot. More than one parent can form that cycle even when a configured
limit exceeds one. The policy does not raise or bypass a concurrency limit and
does not add a Goal step, duration or token budget.

Callers must explicitly apply the option to synchronous dependent queries; this
API alone does not alter task-service or default-pool registration. The option
is host metadata and is not a model argument. A later submission after capacity
becomes available is a fresh admission decision, not an automatic work replay.
