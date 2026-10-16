# Claude attempt ownership and replay

Each logical query creates exactly one SDK query. Disclaude never retries the
whole query or resubmits its input automatically, including failures before
startup and empty responses. There is no replay buffer, replacement query or
replay-admission state machine. The SDK/client may retry API requests inside
the same native execution; productive long tasks have no new duration limit.
The old `DISCLAUDE_QUERY_MAX_RETRIES` override no longer enables host retries.

This directly prevents the old and replacement queries from racing over input
or executing the same side effect. All Claude failures and terminal results
carry a no-replay marker through RestartManager and empty-reply recovery.
Upstream errors retain their actual transient classification. A later explicit
user request can start a new query; it is never inferred from missing output.

The provider owns the process through the SDK's public `spawnClaudeCodeProcess`
hook. On teardown it seals that hook, attempts SDK close and stdin EOF, allows
two seconds for exit, sends SIGTERM and allows five seconds, then escalates to
SIGKILL with a one-second confirmation wait. A failed close/interrupt control
channel does not prevent this cleanup. POSIX processes use a dedicated group;
observed descendants are checked by PID, owner, group and start identity before
signals. No command arguments or environments are inspected. Unrelated process
groups are preserved. Inspection failure remains explicit in the exit report. Windows has native-child exit observation, with process-tree inspection
reported unavailable.

`Claude attempt process settled` logs carry the attempt number and
`nativePid`. Settlement reports `not-started`,
`exited`, `killed` or `unconfirmed`, its exit code/signal, close failure and
inspection availability. Confirmation covers the native process and observed
descendants. `QueryHandle.interrupt()` awaits that confirmation; compatible
void `close()`/`cancel()` initiate the same idempotent cleanup, and iterator
completion awaits it.

Replay denial is separate from upstream transient classification. It survives
error cause wrappers, blocks RestartManager recovery without consuming its
quota, and prevents the empty-reply reset path from resubmitting the original
input. Uncertain empty results advise inspecting prior operations before
continuing. The SDK's ordinary backoff has no new task-duration deadline here.
Native retry-budget coordination and known/unknown usage remain #5362/#5367.
No inference about duplicate billing is made from the child fixtures.

After installing this checkout's dependencies:

```sh
pnpm run build
pnpm exec vitest run packages/core/src/sdk/providers/claude/provider.test.ts packages/core/src/sdk/providers/claude/attempt-process.test.ts packages/core/src/agents/restart-manager.test.ts packages/service/src/agents/chat-agent.test.ts
pnpm exec vitest run packages/core/src/sdk/providers/claude/provider.test.ts -t 'does not replay an accepted input' --disableConsoleIntercept
node tests/integration/claude-attempt-exit.mjs
```

The side-effect regression uses real Node children behind the existing SDK
process mock. It writes a marker before losing the host stream and makes
control close fail. The installed-SDK integration uses an owned loopback 429
endpoint and asserts confirmed interruption plus replay denial. Neither opens
a channel connection or makes an external model request. They are controlled
process/protocol experiments, rather than production-outage acceptance.
