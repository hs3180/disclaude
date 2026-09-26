# Browser control through Disclaude

The browser coordinator runs as a managed child of `disclaude start`. It queues
competing browser-use operations and reclaims the current worker before granting
control to the next caller. The runtime is shipped in the service package; the
actual CLI lifecycle and handoff use case lives in
`tests/e2e/browser-service.test.ts`.

## Configure the service

Before selecting an installed executable, run:

```sh
disclaude browser doctor --binary /absolute/path/to/chromium
```

The command defaults to a visible browser; use `--headless` on a host without a
display. It launches the selected executable twice with one temporary profile
and dynamic loopback CDP ports, tests navigation, input, screenshots and a test
Cookie, then removes its disposable profile. It does not attach to an existing
browser, use an existing profile or change service configuration.

JSON output separates `usable` from `cookiePersistence` (`retained` or
`not-retained`). Normal operation can pass when a Cookie does not survive
restart, including macOS environments that prohibit Keychain access. Only the
explicit `--require-persistence` option makes missing persistence a failing
exit status. Executable, startup, navigation or other functional failures
always exit nonzero. The command never changes Keychain, browser signing or OS
permissions.

This tests the current invoking user's environment. It does not establish Cookie
decryption for an existing profile, login persistence under a different service
manager, authenticity of a downloaded application, or an existing deployment's
migration. The reported CDP product name may say Chrome for a Chromium binary;
the output also identifies the selected executable's resolved path.

Install the browser-use Python environment and an independent Chromium first.
Use the interpreter belonging to that environment, not an unrelated system
Python.

Add these settings to the service configuration's `env` section (absolute paths):

```yaml
env:
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
After readiness it creates a private `browser-use` launcher at
`<socket-directory>/bin/browser-use`. Harness environment construction derives
that directory from `DISCLAUDE_BROWSER_SOCKET` after task/provider merges, puts it first in
PATH, and removes direct CDP/daemon configuration. The skill helper also
derives and invokes the absolute socket-relative launcher, so a tool shell
cannot select an upstream CLI by rewriting PATH; no separate launcher-path
setting is needed. The helper requires the service-provided socket and fails
closed if the service or launcher is unavailable. Do not point it to the
upstream Python CLI or remove the null-runtime guards. If the broker exits,
browser calls fail explicitly and do not fall back to direct CDP or spawn an
independent daemon.

`disclaude browser status [--config PATH]` queries the configured coordinator.
`GET /api/status` also reports its `browserIpc` state (`disabled`, `ready`, or
`unavailable`) and supervised broker PID. Starting, stopping, and restarting
the broker are exclusively part of the Disclaude service lifecycle; the browser
CLI does not start a standalone coordinator.

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

If a supervised broker dies while the service is alive, the supervisor terminates
its dedicated process group, including managed Chromium. Detached harness workers
terminate their own groups when their broker IPC disconnects, including descendant
processes started by the running Python task. The supervisor removes only a socket
and lock matching that broker's PID and unique startup identity. Browser calls fail
until the service is explicitly restarted; unknown work is never replayed.

When a worker announces its daemon but does not become ready, the coordinator
records the startup phase (`worker-startup-timeout`, `worker-startup-exit`, or
`worker-init-error`) and the last 4 KiB of the worker plus supervised daemon
stderr in the private event stream. These diagnostics identify a failed
bootstrap without changing the recovery boundary or retrying unknown browser
work. The daemon stderr is retained only through the worker diagnostic pipe; it
is not exposed to the Agent or persisted with page content.

This recovery requires the owning supervisor to observe the broker exit. Foreign
or unreadable locks and simultaneous loss of broker and supervisor still require
operator inspection. Verify process ownership and CDP detachment before clearing
those files. Socket permissions coordinate same-user callers; this is not a
sandbox for hostile Python or a multi-user authorization boundary.

## Existing standalone browser IPC services

Disclaude does not discover, import settings from, stop, or remove a standalone
browser IPC service left by an older installation. Configure browser settings in
the current Disclaude config and disable any old broker separately before
starting the service on a socket it may still hold. Startup does not alter
Chromium CDP services or profiles, browser pages, workspaces, or other
service-manager entries.

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
npx vitest run --config vitest.e2e.config.ts tests/e2e/browser-service.test.ts
```
