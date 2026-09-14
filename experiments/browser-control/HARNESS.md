# Real browser-use IPC integration (#5002)

This opt-in follow-up reuses the installed **browser-use 0.13.10 /
browser-harness 0.1.13** daemon and Python helpers. The coordinator manages its
lifecycle instead of implementing browser commands in another browser engine.

```text
Agent's browser-use stdin script
  -> task-scoped CLI shim
  -> Unix socket: acquire / wait / execute / heartbeat / release
  -> FIFO coordinator + owned adapter process group
  -> upstream browser-use CLI -> upstream harness IPC daemon -> CDP -> Chromium
```

## Run locally

Requires macOS or Linux, Node >=22, and a Python interpreter with the tested
browser-use/harness versions installed. Set the Python path explicitly if the
shell's `python3` belongs to another installation.

Create a short private runtime directory (0700), then start the service in one
terminal. These examples assume the current directory is the repository root.

```sh
mkdir -m 700 /tmp/disclaude-browser-lab
# Pick a fresh dedicated profile; do not reuse the currently running launchd profile.
DISCLAUDE_BROWSER_SOCKET=/tmp/disclaude-browser-lab/browser.sock \
DISCLAUDE_BROWSER_PYTHON=/absolute/path/to/python \
DISCLAUDE_BROWSER_WORKSPACE=/absolute/path/to/task-workspace \
DISCLAUDE_CHROMIUM_BINARY=/Applications/Chromium.app/Contents/MacOS/Chromium \
DISCLAUDE_CHROMIUM_PROFILE=/absolute/path/to/dedicated-ipc-profile \
node experiments/browser-control/service.mjs
```

Managed Chromium uses `--remote-debugging-port=0`. The service waits for a fresh
`DevToolsActivePort` record and verifies the browser WebSocket identity before
accepting clients. The default is headed; set `DISCLAUDE_CHROMIUM_HEADLESS=1`
for headless Linux. Running Chromium as root inside the acceptance container
uses `--no-sandbox`, matching the container boundary, not a host recommendation.

Alternatively set **only** `BU_CDP_URL` in the service's environment to attach to
an existing automation Chromium. Do not also set `DISCLAUDE_CHROMIUM_BINARY`.
The service creates a shared page unless `DISCLAUDE_BROWSER_TARGET` selects an
existing target. Normal release preserves that page and login state. Service
shutdown preserves an externally managed browser; in managed mode it stops its
own Chromium and keeps the profile directory.

In the task's environment, inject just the socket and prepend the scoped shim:

```sh
export DISCLAUDE_BROWSER_SOCKET=/tmp/disclaude-browser-lab/browser.sock
export PATH="$PWD/experiments/browser-control/bin:$PATH"
browser-use <<'PY'
goto_url('data:text/html,<h1>IPC browser</h1><input id=name>')
assert wait_for_element('#name')
fill_input('#name', 'hello')
print(js("document.querySelector('#name').value"))
PY
```

Each CLI invocation owns one complete operation segment and releases after it.
Put dependent actions in the same script. The JS `connectBrowser` client can
hold a connection/lease across multiple `execute` calls; it must heartbeat and
release explicitly. The stdio shim handles heartbeats while executing a script.
It deliberately rejects `--reload`, `--update` and other daemon lifecycle
commands; callers cannot use this entry point to restart another holder's daemon.
The service invokes upstream through Python directly, so the shim cannot recurse.

## Ownership and failure handling

The socket lives in a private directory and has mode 0600. The server binds an
execution identity to each client connection; clients do not supply lease tokens
or impersonate another connection. Calls from one lease are serialized and checked
again at actual dispatch. Waiters receive a queue response immediately, then await
`wait`. A disconnected waiter is removed, including during allocation.

Each lease has a private harness runtime and process group. The coordinator
starts the existing harness daemon itself, then invokes browser-use with
`BH_REQUIRE_EXISTING_DAEMON=1`: helpers fail if that daemon is lost instead of
silently spawning another one. Revocation stops the worker and its CLI/daemon
process group, verifies browser-side detachment, and only then grants the next
request. An in-flight result lost on disconnect remains unknown, without replay.

Current limits: 5-second lease TTL, 1-second CLI heartbeat, 180-second hard hold
limit, 120-second queue wait and script timeout. These are opt-in integration
values, not a published service contract. Script stdout/stderr is limited to 2 MiB.
Artifacts are written in the service's configured workspace; per-task workspace
routing is not implemented yet. `DISCLAUDE_BROWSER_EVENTS` writes lifecycle
NDJSON without script bodies or lease tokens.

## Reproduce acceptance

```sh
DISCLAUDE_BROWSER_PYTHON=/absolute/path/to/python \
DISCLAUDE_CHROMIUM_BINARY=/absolute/path/to/Chromium \
DISCLAUDE_BROWSER_MANAGED=1 \
node experiments/browser-control/harness-acceptance.mjs /absolute/path/to/evidence

# Independent Linux acceptance image; no production image or service required.
docker build -t disclaude-browser-harness-lab experiments/browser-control
docker run --rm --init --shm-size=2g --memory=4g \
  -v /absolute/path/to/evidence:/evidence disclaude-browser-harness-lab
```

The tests start an isolated headless browser/profile. They exercise actual
browser-use helpers, two queued IPC clients, old-client fencing, allocation and
queue cancellation, malformed method rejection, caller disappearance during a
script, harness daemon death, silent-holder expiry, a CLI script lasting beyond
TTL with heartbeat, screenshots, and ten repeated shared-page handoffs. No real
account or external writes are involved. The GitHub workflow runs the same image
on native Linux/amd64 and uploads evidence.

## Rollout boundaries

This is a working, opt-in integration under `experiments/`, not a replacement
installed into production. Existing launchd configuration is unchanged. The new
service has a single owner lock and refuses a second instance. Unclean service
termination may leave a lock/profile or workers requiring operator recovery;
automated restart reconciliation is **not implemented**. Do not configure launchd
KeepAlive for it until that recovery and process-identity handling are completed.
Chromium loss terminates the managed service; unknown operations are not retried.

The socket permissions provide a same-user cooperative boundary. Python scripts
still have the service account's filesystem/environment access; this is not a
sandbox for hostile code or a multi-user authorization service. Task-scoped PATH
and socket injection have not yet been wired into the production agent runtime.
No model-driven agent acceptance has been run. Remaining work: runtime/workspace
binding, restart recovery,
launchd/Linux service packaging and real-agent acceptance. This work is independent
of Agentic Research.


## Storage policy and platform evidence (2026-09-14)

Denied macOS Keychain access is a **supported security configuration**, not a
browser-service setup failure. Normal navigation, input, screenshots, in-browser
cookies, ownership and handoff must work without requesting Keychain access.
The service does not enable mock keychains, switch to plaintext storage, copy
personal browser credentials, or change OS permissions to satisfy an acceptance.

Cross-browser-restart cookie retention is a separate capability. The acceptance
always verifies cookie availability before and after lease handoff in the running
browser. It also probes profile reopening and records `persistence.retained`.
Missing retention does not fail the normal control acceptance; an application
explicitly requiring durable login state can run with
`DISCLAUDE_BROWSER_REQUIRE_PERSISTENCE=1` to make that capability mandatory. The
Linux acceptance image opts into this stricter contract, so persistence regressions
there still fail CI. Never describe `retained: false` as persistence passing.

- macOS arm64 / Chromium 155: **9 control/IPC checks pass** with Keychain denied.
  Profile-restart cookie retention is unavailable in this environment. A direct
  Chromium-only reproduction confirms the same behavior with
  `errSecInteractionNotAllowed (-25308)` / `Encryption is not available`.
  This requires no security-setting change for normal browser use. After a browser
  restart, a site may require a new login when its authentication cookies are gone.
- Linux arm64 / Chromium 151: **10 checks pass**, including fresh cookie retention
  across graceful managed-browser shutdown and profile reopening.
- The original deterministic CDP coordinator regression still passes all
  10 scenarios / 115 grants after adding the harness adapter hooks.

Output summaries are removed before each run; required-check failures produce
`failure.json` so a previous passing summary cannot be mistaken for new evidence.
Optional capability limitations are recorded explicitly in the successful summary.
