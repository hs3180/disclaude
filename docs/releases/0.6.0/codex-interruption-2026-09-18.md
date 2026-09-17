# Real Codex interruption verification

On 2026-09-18, integrated candidate `81497d4c` combined interruption fixes
`ab3b9d92` with main `a568158e`, including TASK.md removal. Build and 163
ChatAgent/provider app-server regressions passed.

The independent verification process used the built ChatSessionPool, ChatAgent
and real Codex app-server provider. It explicitly selected `gpt-5.6-luna` for
both queries. Delivery callbacks were captured; no Feishu service was connected,
production was unchanged and no computer-use calls were made.

The first turn started a Python probe that wrote its PID and working directory,
then slept before an eventual completion-file write. After observing the live
PID, the client called the actual query handle's `interrupt()`; it did not call
ChatAgent.stop or inject an artificial result. Codex's rollout recorded
`turn_aborted` with reason `interrupted`, and the provider emitted a result with
`terminatedReason: interrupted`.

The waiting runOnce caller rejected with `Agent turn interrupted by backend`.
The tool PID exited, its completion file was absent, and no successful result
callback was recorded. Exactly one stopped notification was produced. Its
send callback was deliberately held pending to model slow delivery.

While that notification remained pending, an explicit follow-up created a new
SDK query on the same agent. Releasing the notification did not settle or cancel
the replacement turn. The second Python probe wrote `RESUMED` and the second
turn completed successfully. There was no automatic retry or reconnect notice.
The actual rollout contains the interrupted and completed turn IDs under one
thread, both with Luna and the original working directory.

After pool/provider disposal there were no process references to the temporary
root, and the root was removed. This verifies real backend interruption and
query reentry while notification delivery is delayed. It does not verify a
real Feishu HTTP delay, production deployment, document feedback recovery,
multiple concurrent Research projects or complete Research UX. Those scopes
remain separate acceptance requirements.
