# Browser control through Disclaude

One `browser-use` CLI invocation is one exclusive unit, including the entire
Python script on stdin. Disclaude supplies a thin launcher that takes an OS file
lock, executes the installed upstream CLI, and releases the lock after it exits.
There is no Disclaude broker socket, lease protocol, Node worker, Python runner,
or managed Python environment.

## Setup and ownership

Install the upstream [Browser Use CLI](https://github.com/browser-use/browser-use)
on the **Disclaude service's PATH**. Its executable/shebang selects its runtime;
Disclaude neither searches for a Python interpreter nor installs a venv. The
selected absolute CLI path is logged at service startup. A shell with the CLI on
PATH does not prove that launchd/systemd has the same PATH.

Deploy Chromium separately, for example with `disclaude chromium-cdp install`.
Disclaude reads the installed `chromium-cdp.json` first; `BU_CDP_URL` is a
service-side fallback only when that file is absent. Invalid installed config
fails explicitly. Browser binary, profile and display settings belong to the
Chromium deployment, not to command coordination.

Service startup discovers the browser's CDP identity and publishes an internal
manifest and launcher. Agents receive the launcher automatically after their
provider/task environment merges. The skill helper selects it by absolute path
even if the tool shell changes PATH. Users configure neither a socket nor
`DISCLAUDE_BROWSER_BIN`/`DISCLAUDE_BROWSER_WORKSPACE`.

The lock and upstream session namespace use the browser's own ID, shared across
Projects, workspaces, service configurations and aliases for the same CDP URL.
These are internal local files, not a new Research workspace. Upstream scratch,
configuration and daemon state live in that private namespace (`BH_HOME`,
`BH_RUNTIME_DIR`, `BH_TMP_DIR`); they do not require access to the user's global
Browser Harness config directory. Relative output paths still use the task's cwd.
The browser's profile is never moved or recreated.

## Calling convention

```sh
browser-use <<'PY'
new_tab('data:text/html,<input id=name>')
assert wait_for_element('#name')
fill_input('#name', 'example')
print(js("document.querySelector('#name').value"))
PY
```

Arguments, stdin, cwd, stdout, stderr and the upstream command's exit status are
preserved. Output is streamed, not collected into an IPC response. A waiting call
may print a queue notice on stderr. There is no command execution deadline or
cross-call lease. The kernel decides waiter order; FIFO is not promised.

Put dependent operations in one invocation. Between calls another task may
change the page, so inspect current state before continuing. Browser-side effects
are not transactions and are not rolled back. Starting asynchronous page work or
background processes does not extend the CLI's exclusive unit.

The original CLI starts/reuses its own persistent daemon. Disclaude does not
start a daemon per call, implement its Python APIs, or install another supervisor.
The upstream daemon's own internal IPC is an implementation detail of Browser Use.

## Availability, cancellation and recovery

`disclaude browser status [--config PATH]` reports `idle`, `busy`, or
`interrupted`; it does not invent a lease queue length. The existing HTTP
`/api/status.browserIpc` field is retained for API compatibility and reports
command availability (`disabled`, `ready`, `unavailable`) plus the service PID,
not a separate IPC process. Readiness checks executable/CDP discovery, not a
successful browser operation; use the actual CLI to establish that.

Graceful service stop withdraws the manifest/launcher. Wrappers check service
ownership while waiting or executing and cancel their CLI process group if that
ownership disappears. Cancellation forwards SIGINT/SIGTERM, with a bounded
SIGKILL escalation if the child ignores it. This is not an execution timeout.
The separately deployed Chromium/profile and upstream shared daemon are not
owned by the Disclaude service and are not killed on every service stop.

On macOS, `lockf` acquires an inherited descriptor; Linux uses `flock`.
The actual CLI inherits the same descriptor. If a wrapper is SIGKILLed, a still
running CLI retains the lock until it exits. Do not unlink or replace lock files
to “unlock” a live browser: waiters must keep referring to the same inode.

A failed/nonzero or interrupted invocation leaves a small outcome marker.
Subsequent commands fail explicitly instead of automatically replaying unknown
work or overlapping a possibly unfinished daemon operation. After inspecting the
failure and any browser-side result, use the coordinated `browser-use --reload`
entry to stop the upstream session and clear the guard. Reload also takes the
same lock and keeps the guard if a previously recorded daemon is still alive.
It may close the daemon-owned tab; the next invocation starts a fresh
session. It does not reset Chromium or its profile. Do not clear the marker by
hand or automatically resubmit side-effecting scripts.

Task environments retain null-runtime guards to reject accidentally choosing an
absolute uncoordinated CLI. The wrapper replaces them with the private upstream
namespace. This is cooperative same-user routing, not a sandbox against code
that deliberately removes guards or opens CDP directly. Local file locks do not
coordinate different machines or unrelated tools controlling the same browser.

There is no legacy service migration. This code does not discover or stop old
LaunchAgents/systemd units, change production configuration, or clean user data.

## Diagnostics and validation

`disclaude browser doctor --binary /absolute/browser/path [--headless]` remains a
separate, explicit Chromium test with disposable state. It distinguishes browser
usability from Cookie persistence; `--require-persistence` makes missing
persistence fail. It does not test this coordination path or change Keychain/OS
permissions.

```sh
pnpm test
pnpm run lint
pnpm run build
DISCLAUDE_E2E_CHROMIUM=/absolute/path/to/chromium \
DISCLAUDE_E2E_BROWSER_PYTHON=/path/to/upstream-cli-environment/bin/python \
DISCLAUDE_E2E_BROWSER_STRESS=1 \
pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/browser-service.test.ts
```

The Python variable above identifies the isolated test's upstream CLI installation,
not a production setting. CI installs Browser Use 0.13.10 / Browser Harness
0.1.13. Unit/process tests cover complete-call serialization across configs,
argument/stream/exit forwarding, queued cancellation, wrapper SIGKILL, service
withdrawal, and interrupted recovery. The real-browser case uses a separate
Chromium/CDP/profile, tests shared state, persistent daemon reuse, 100 handoffs
when enabled, cancellation, service crash/restart and owned-resource cleanup.
It must not attach to production CDP/profile.

Default tests make no model calls or Feishu requests. Optional model handoffs
remain available through the existing `DISCLAUDE_E2E_BROWSER_*` switches; each
test must use an explicitly selected model rather than inherit a machine-global
default. Deterministic CLI tests are not evidence that a model discovered the
skill, that a real site retained login, or that production/Feishu acceptance
passed.
