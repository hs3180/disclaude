# Browser control ownership lab (#5002)

The reusable coordinator and CDP transport now live in
`packages/service/src/browser-control/`. Lab modules delegate there; the original
results below remain historical experimental evidence. Current product entry and
service integration are documented in [browser coordination](../../docs/browser-coordination.md).

The experiment asks whether a waiting caller can acquire usable control after the
holder releases, crashes, disconnects or expires. Both callers intentionally use
the **same page**. Seeing the previous caller's page is expected; ordinary lease
reclamation preserves that page and its contents.

This is an opt-in, dependency-free Node >=22 experiment, outside the production
service. Deterministic callers exercise a FIFO coordinator and separate Node CDP
worker processes. There is no model invocation or external account interaction.

## Reproduce

Use an automation Chromium CDP endpoint. The runner creates one blank test page,
writes a local DOM fixture and closes only its own page at the end. It does not
navigate existing pages, restart the browser, or close other clients' connections.
Do not use a personal daily browser. No published port is needed for Docker:

```sh
# macOS: use the dedicated launchd Chromium service
node experiments/browser-control/run.mjs http://127.0.0.1:9223 /absolute/path/to/evidence

# Linux/Docker: inside a running dedicated Chromium container with Node >=22,
# mount experiments/browser-control at /lab (read-only) and an output dir at
# /evidence. The image from PR #5011 was used for the recorded Linux test.
node /lab/run.mjs http://127.0.0.1:9222 /evidence
```

The runner exits nonzero on assertion failure. `events.ndjson` records queue,
grant, actual command send, revoke, worker exit, browser-side detach and reclaim
sequence. `summary.json` records environment and outcomes; `shared-page.png`
shows a successfully handed-over page. Tokens and page bodies are not logged in
events. Local test values are fixed, and no real saves are performed.

## What it enforces

- One held lease at a time, FIFO requests, cancellable/timed-out waiters.
- Worker startup and attach complete before granting usable control.
- Per-lease serial execution; lease identity, epoch and monotonic deadline are
  checked again immediately before sending a command to the worker.
- Heartbeats can extend TTL only up to a fixed hard deadline.
- Release, worker death, CDP disconnect and expiry revoke the lease before
  stopping its worker. Exit closes worker-owned OS connections. The runner also
  confirms the test target has no attached session before completing reclamation.
- The next worker attaches to the same target and must successfully read/write.
- Old commands, heartbeats and release calls cannot act on a successor's lease.
- An in-flight stalled operation is unknown on worker death and is not replayed;
  queued-but-unsent operations are rejected after expiry.
- Failed browser-side reclamation quarantines the resource and fails waiters
  explicitly; it does not grant an overlapping controller. Automatic recovery
  from quarantine is not implemented in this lab.

The worker exposes only fixture read/write, screenshot and an injected stall.
Normal revocation requests graceful socket closure; after 500 ms it kills only
the owned worker. Test TTL is 600 ms, hard deadline 2500 ms, monitor tick 20 ms;
these are accelerated experimental values, not product defaults.

## Recorded results (2026-09-14)

| Environment | Chromium | Checks | Grants | Successful reclaim P95 / max |
| --- | --- | --- | --- | --- |
| macOS arm64, native worker + launchd browser | 155.0.8057.0 | 10/10 | 115 | 3.21 / 13.46 ms |
| Linux arm64, worker and headed/Xvfb browser inside Docker | 151.0.7922.34 | 10/10 | 115 | 3.17 / 16.26 ms |

Each run includes 100 requests enqueued together and completed FIFO, with actual
read/write assertions for every grant. Other scenarios cover normal handoff,
stale holder interference, worker kill, CDP disconnect, expiry, in-flight stall,
waiter cancellation/timeout, continuous heartbeat with hard expiry, and injected
reclaim failure. Shared target and browser identity survive the handoffs. All
workers exit; successful reclamations also have browser-side detach evidence.
The final quarantine injection intentionally has no successful reclaim event.
Checked-in JSON summaries contain the exact results.

Reclaim duration measures **revocation start to browser-side detachment**, not
request wait, TTL detection delay or complete handoff latency. These short local
runs are not a long-term performance guarantee.

## Boundaries / remaining work

This proves cooperative scheduling and fault handoff for controlled workers.
Callers are deterministic async tasks, not two model agents. The local in-process
API is not an authorization boundary: callers with direct CDP access can bypass
it. A production adapter must bind execution identity, route all control through
the coordinator, and prevent independent daemon cleanup from affecting holders.

Not tested: production browser-use integration, model-driven tasks, coordinator
restart, Chromium restart/replacement, network partitions, real external saves,
Linux amd64 or native Linux host service. The existing #5011 amd64 container CI
is separate evidence and does not cover this coordinator experiment. Next steps
are the browser-use adapter and real-agent handoff, then recovery across service
and browser restarts. Agentic research is independent of this work.


See [HARNESS.md](HARNESS.md) for the opt-in real browser-use IPC adapter and managed dynamic-port Chromium follow-up. The original deterministic results above describe the CDP-only experiment.
