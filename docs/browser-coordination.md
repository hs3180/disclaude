# Browser control through Disclaude

The browser coordinator runs as a managed child of `disclaude start`. It queues
competing browser-use operations and reclaims the current worker before granting
control to the next caller. The runtime is shipped in the service package;
the actual CLI lifecycle and handoff use case lives in
`tests/e2e/browser-service.test.ts`.

## Configure the service

Install the browser-use Python environment and an independent Chromium first.
The validated harness baseline is browser-use 0.13.10 / browser-harness 0.1.13.
Use the interpreter belonging to that environment, not an unrelated system Python.

Add these settings to the service configuration's `env` section (absolute paths):

```yaml
env:
  DISCLAUDE_BROWSER_MODE: coordinated
  DISCLAUDE_BROWSER_SOCKET: /absolute/private/browser.sock
  DISCLAUDE_BROWSER_PYTHON: /absolute/path/to/python
  DISCLAUDE_CHROMIUM_BINARY: /Applications/Chromium.app/Contents/MacOS/Chromium
  DISCLAUDE_CHROMIUM_PROFILE: /absolute/dedicated/browser-profile
```

Create the socket parent directory with mode 0700. Unix socket paths are limited
to 95 bytes. On Linux without a display, also set `DISCLAUDE_CHROMIUM_HEADLESS: "1"`,
or use the supported headed/Xvfb environment. Do not reuse a profile owned by
another browser service. In existing-browser mode, set only `BU_CDP_URL` in the
service environment and omit the managed binary/profile; shutdown preserves that
external browser.

`disclaude start --config ...` waits for browser readiness before starting agents.
After readiness it creates a private `browser-use` launcher next to the socket.
Harness environment construction puts that launcher first in PATH, after task
and provider merges, and removes direct CDP/daemon configuration. No manual agent
PATH modification or experiment command is needed. If the broker exits, browser
calls fail explicitly and the service logs the failure; they do not fall back to
direct CDP or spawn an independent daemon.

The public `disclaude browser start` command runs the configured coordinator in
the foreground, and `disclaude browser status` queries its live state. These two
commands read process environment; when using a configuration-file-managed service,
set its socket path in the status command's environment. They do not create or
change operating-system service registrations.

## Browser operations

Agents continue using the installed browser-use Python helpers through stdin:

```python
goto_url('data:text/html,<input id=name>')
assert wait_for_element('#name')
fill_input('#name', 'example')
print(js("document.querySelector('#name').value"))
```

Pipe a complete dependent sequence into one `browser-use` invocation. Each
invocation queues, acquires control, executes, and releases. Callers share pages;
normal handoff preserves the previous caller's page. Daemon lifecycle commands
such as `--reload` are rejected at this entry.

## Recovery boundaries

Normal service shutdown stops its broker, active workers and owned Chromium,
keeps the profile, and removes the socket/lock. Graceful service restart reopens
that profile. Denying macOS Keychain access is supported for normal operation;
cross-browser-restart cookie retention is a separately detected capability.

Unclean broker death is not automatically reconciled. A remaining lock causes
startup to fail; an operator must verify old process ownership and CDP detachment
before clearing it. Do not blindly remove a lock, replay an unknown operation or
configure automatic broker restart until that recovery is implemented. Existing
launchd profile migration and native Linux service-manager installation remain
separate work. Socket permissions coordinate same-user callers; this is not a
sandbox for hostile Python or a multi-user authorization boundary.

## Validation

Core lifecycle/environment tests:

```sh
npx vitest run packages/service/src/browser-control/runtime.test.ts packages/core/src/utils/browser-env.test.ts
```

Actual CLI-to-browser use case (isolated profile, no external accounts/messages):

```sh
npm run build
DISCLAUDE_E2E_CHROMIUM=/absolute/path/to/chromium \
DISCLAUDE_E2E_BROWSER_PYTHON=/absolute/path/to/python \
npx vitest run tests/e2e/browser-service.test.ts
```

It starts the real Disclaude service, checks the public status command, executes
competing browser-use callers against the same real page, then checks shutdown,
profile retention and service restart. Without both environment variables the
case is reported skipped. This verifies the CLI/harness/browser chain, not a model
agent deciding how to use it. It also interrupts a running caller and verifies
that the queued caller takes over without executing the abandoned operation.
Linux CI installs the pinned browser-use runtime and uses the runner image's
packaged Google Chrome (logging its version), then runs this same product test. No separate test Docker image or standalone harness runner
is required. The test layout follows #5016: core unit tests plus actual-use-case E2E.

Environment filtering happens only where an execution environment is finalized:
Claude SDK options, Codex exec/app-server subprocesses, the dsh subprocess, and
Pi's NodeExecutionEnv. These are distinct execution paths; Pi runs in-process
and Claude owns its subprocess creation, so they do not share one spawn function.
Earlier SDK environment assembly and Pi option adaptation do not filter again.
The shared helper contains the policy; each boundary applies it after its own
merges. Direct worker configuration remains private to the service.
