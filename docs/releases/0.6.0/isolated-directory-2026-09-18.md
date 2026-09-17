# Isolated execution directory verification

On 2026-09-18, locally integrated candidate `840e8233` combined the directory
fix `05fb06f0` with main `a568158e` (including TASK.md removal). The pool and
ChatAgent sources were unchanged from the fix. Build and all 77 pool tests passed.

An independent Node process used the real built ChatSessionPool, ChatAgent and
Codex app-server provider. The provider was observed, not mocked; all queries
explicitly selected `gpt-5.6-luna`, independently confirmed in the three rollouts.
Channel delivery callbacks were captured locally, with no Feishu connection.

1. A scoped execution created under project A ran a Python file probe in A.
2. The chat binding changed to B. Resetting the same scoped agent forced a new
   SDK query. Its second probe still wrote to A; B had no second-probe artifact.
   Both queries retained the same isolated session identity.
3. A was moved away. Resetting and sending another request emitted the missing
   directory warning, created no SDK query, and wrote nothing in B.
4. An ordinary chat agent under the same delivery chat ran in B, using its
   distinct ordinary session identity. Its probe artifact and model command
   output independently confirmed B.

These results establish the real model/query reconstruction boundary, not a
production deployment, concurrent Research workflow, crash recovery or full
Feishu UX pass. Production was untouched and computer use was not invoked.
Provider and pool were disposed, no temporary-root process references remained,
and the owned temporary root was removed.

Two earlier attempts are retained as failures: the first test harness omitted
service bootstrap's default-provider selection and failed authentication before
any Codex query; the second model omitted the unquoted `first` command argument
and its probe raised IndexError. The final run quoted the complete command and
verified the actual file contents and rollout commands rather than relying on
model success text.

The tested candidate did not contain contextual-feedback PR #5100. Its second
and ordinary turns attempted unnecessary follow-up menu commands, which failed
because no channel CLI was exposed by this isolated harness. That observation
is not a channel-delivery success or a new isolation failure; it remains relevant
to the separate feedback-guidance change.
