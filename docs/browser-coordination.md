# Browser control through Disclaude

The browser coordinator runs in-process as part of `DisclaudeService`. It queues
competing browser-use operations and reclaims the current worker before granting
control to the next caller. It attaches to the Chromium CDP service already
deployed on the host; it never launches or owns Chromium. The runtime is shipped
in the service package; the actual CLI lifecycle and handoff use case lives in
`tests/e2e/browser-service.test.ts`.

## Configure the service

Before selecting an installed executable, run:

```sh
disclaude browser doctor --binary /absolute/path/to/chromium
```

The command defaults to a visible browser; use `--headless` on a host without a
display. It launches the selected executable twice with one temporary profile and
dynamic loopback CDP ports, tests navigation, input, screenshots and a fictional
test Cookie, then removes its disposable profile. It does not attach to an
existing browser, use an existing profile or change service configuration.

JSON output separates `usable` from `cookiePersistence` (`retained` or
`not-retained`). Normal operation can pass when a Cookie does not survive restart,
including macOS environments that prohibit Keychain access. Only the explicit
`--require-persistence` option makes missing persistence a failing exit status.
Executable, startup, navigation or other functional failures always exit nonzero.
The command never changes Keychain, browser signing or OS permissions.

This tests the current invoking user's environment. It does not establish Cookie
decryption for an existing profile, login persistence under a different service
manager, authenticity of a downloaded application, or an existing deployment's
migration. The reported CDP product name may say Chrome for a Chromium binary;
the output also identifies the selected executable's resolved path.

`tests/e2e/browser-doctor.test.ts` runs the actual product CLI when
`DISCLAUDE_E2E_CHROMIUM` is set and checks capability output and temporary-state
cleanup. Linux CI requires Cookie retention. The macOS ARM64 CLI case passed on
2026-09-16 with Chromium 155.0.8057.0 (1.38 seconds); a separate default-headed
invocation also passed. Both observed retention in that invoking environment.
Earlier service-environment failures remain distinct evidence.

Install and start the host's Chromium CDP service separately, for example with
`disclaude chromium-cdp install`. The coordinator reads its saved CDP address and
port from the existing Chromium configuration. Also make the validated
browser-use 0.13.10 / browser-harness 0.1.13 Python environment available as
`python3` in the Disclaude service's `PATH`.

No browser socket setting or socket-directory setup is required. The Disclaude
service derives a private Unix-domain socket path from its runtime identity,
creates its parent directory with mode 0700, and injects the endpoint only into
its agent subprocesses. The path stays within the platform's 95-byte Unix socket
limit.

The coordinator has no Chromium binary, profile, headless, Python, or
agent-visible direct-CDP URL settings. Those belong to the independently
deployed browser service. Disclaude prefers its persisted CDP endpoint and can
reuse an endpoint already supplied to the service deployment when no config
file is mounted.

`disclaude start --config ...` waits for browser readiness before starting agents.
After readiness it creates a private `browser-use` launcher beside the internal
socket. Harness environment construction derives that directory after
task/provider merges, puts it first in PATH, and removes direct CDP/daemon
configuration. The skill helper invokes the absolute socket-relative launcher,
so a tool shell cannot select an upstream CLI by rewriting PATH; users do not
configure the socket or launcher path. Do not point it to the upstream Python
CLI or remove the null-runtime guards. No manual agent PATH modification or
experiment command is needed. If the coordinator becomes unavailable, browser
calls fail explicitly; they do not fall back to direct CDP or spawn an
independent daemon.

`disclaude browser status [--config PATH]` queries the service-owned coordinator.
`GET /api/status` also reports its `browserIpc` state (`disabled`, `ready`, or
`unavailable`) and the owning Disclaude service PID. Starting, stopping and
restarting the coordinator is exclusively part of the Disclaude service
lifecycle; the browser CLI does not start a standalone coordinator.

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

Normal service shutdown stops active workers, closes its CDP connection, and
removes the socket/lock. The separately deployed Chromium service, its profile,
and its pages remain running and owned by that service.

The coordinator shares the Disclaude service process; there is no broker child or
separate supervisor. Detached harness workers terminate their own process groups
when their IPC disconnects, including descendants started by the running Python
task. If the service exits unexpectedly, a later start removes only stale socket
state whose owner PID is no longer alive. Browser calls fail closed and unknown
work is never replayed.

When a worker announces its daemon but does not become ready, the coordinator
records the startup phase (`worker-startup-timeout`, `worker-startup-exit`, or
`worker-init-error`) and the last 4 KiB of the worker plus supervised daemon
stderr in the Disclaude service log. These diagnostics identify a failed
bootstrap without changing the recovery boundary or retrying unknown browser
work. The daemon stderr is retained only through the worker diagnostic pipe; it
is not exposed to the Agent or persisted with page content.

Foreign or unreadable locks still require operator inspection. Socket permissions
coordinate same-user callers; this is not a
sandbox for hostile Python or a multi-user authorization boundary.

## Existing standalone browser IPC services

Disclaude does not discover, import settings from, stop, or remove a standalone
browser IPC service left by an older installation. Configure the browser
settings in the current Disclaude config and disable any old broker service
separately before starting the service on a socket it may still hold. Startup
does not alter Chromium CDP services or profiles, browser pages, workspaces, or
other service-manager entries.

## Validation

Core lifecycle/environment tests:

```sh
npx vitest run packages/service/src/browser-control/runtime.test.ts packages/core/src/utils/browser-env.test.ts
```

Actual CLI-to-browser use case (isolated external CDP/profile, no external accounts/messages):

```sh
npm run build
DISCLAUDE_E2E_CHROMIUM=/absolute/path/to/chromium \
DISCLAUDE_E2E_BROWSER_PYTHON=/absolute/path/to/python \
npx vitest run --config vitest.e2e.config.ts tests/e2e/browser-service.test.ts
```

The test starts an isolated Chromium CDP process first, writes its endpoint to the
same persistent config used by `chromium-cdp`, then starts the real Disclaude
service. It checks the public status command and competing browser-use callers on
the shared page. Without both fixture variables the case is skipped. It also
interrupts a running caller and verifies handoff without replaying the abandoned
operation. Finally it kills the Disclaude process during an active Python task:
the worker descendants must exit, while Chromium and its profile remain alive;
the next service start reclaims stale IPC state. Graceful stop is checked to leave
the external CDP service untouched. This verifies the CLI/harness/browser chain,
not a model agent deciding how to use it.
Linux CI installs the pinned browser-use runtime and uses the runner image's
packaged Google Chrome (logging its version), then runs this same product test.
No separate test Docker image or standalone harness runner is required. The test
layout follows #5016: core unit tests plus actual-use-case E2E.

Environment filtering happens only where an execution environment is finalized:
Claude SDK options, Codex exec/app-server subprocesses, the dsh subprocess, and
Pi's NodeExecutionEnv. These are distinct execution paths; Pi runs in-process
and Claude owns its subprocess creation, so they do not share one spawn function.
Earlier SDK environment assembly and Pi option adaptation do not filter again.
The shared helper contains the policy; each boundary applies it after its own
merges. Direct worker configuration remains private to the service.


For real model-to-model browser handoff, additionally set
`DISCLAUDE_E2E_BROWSER_MODEL` to a configured dsh model and
`DISCLAUDE_E2E_BROWSER_CODEX=1` with an authenticated installed Codex CLI.
The Codex leg is explicitly pinned to `gpt-5.6-luna`; it does not inherit the
machine's global Codex model default. The same case then runs dsh followed by
Codex through the product launcher. Each
model reads the previous page value, asserts it, writes its own marker, and emits
the previous value in its tool output. The test checks that output and independently
reads the resulting page through another caller. Either backend can also be enabled
alone. These options make real model calls; default CI omits them. Model credentials
belong in the process environment/auth configuration, never in committed fixtures.

To test Codex skill discovery and use from a natural-language task, also set
`DISCLAUDE_E2E_BROWSER_NATURAL=1`. The Codex run receives the shipped skill index
and a request to inspect the current page, change its input and save a screenshot;
it receives no Python command or selector. The test requires a tool result from
reading the browser skill, the previous value, a valid PNG and independent page
readback. Other enabled backends retain their explicit-command handoff test.

This covers sequential model backends sharing a page. It does not establish
simultaneous model arbitration, all provider backends, real-site authentication or
Feishu interaction. The non-model portion separately tests concurrent callers and
abandoned-worker recovery.


## Accidental upstream CLI selection

In coordinated agent environments, `BH_RUNTIME_DIR` and `BH_TMP_DIR` point to the
OS null device and `BH_REQUIRE_EXISTING_DAEMON=1`. The upstream browser-harness
0.1.13 entry cannot treat that device as a directory and fails before discovering
or spawning a default daemon. This guard remains effective after the coordinator
stops. The product launcher uses IPC; the coordinator's worker sets a separate
private runtime and continues to execute normal operations.

This addresses a real model choosing an absolute upstream executable instead of
the supplied launcher. It is cooperative routing protection, not a same-user
security sandbox: arbitrary shell code can remove environment variables. Do not
interpret environment filtering as protection against deliberately bypassing it.

Optional `DISCLAUDE_E2E_BROWSER_CLAUDE_MODEL` and
`DISCLAUDE_E2E_BROWSER_PI_MODEL` add Claude SDK and Pi harnesses to the existing
sequential model test. Supply a model supported by the configured Anthropic-compatible
API; a Codex model name does not automatically work there. Pi requires its optional
0.83.0 packages as described in [Pi setup](pi-backend.md). Only the configured API
host is allowed through the test network guard for this explicit opt-in. Default
CI makes no model requests. Claude/Pi expose Bash for this controlled task, and the
prompt supplies an exact stdin pipe command; this does not test unrestricted Skill
selection or compare model quality.

On 2026-09-16, macOS ARM64 passed the full dsh → Codex → Claude SDK → Pi sequence,
independent readback, blocked upstream entry before/after service stop, and the
then-current coordinator-crash cleanup in 55.65 seconds. That historical run
predates the in-process coordinator and does not validate the current crash path.
Versions: Node 24.8.0, Chromium 155.0.8057.0,
dsh 0.1.2-rc.1, Codex 0.154.0, Claude SDK 0.3.263, Pi 0.83.0. dsh/Claude/Pi used
DeepSeek's `deepseek-flash` through their respective harnesses; Codex used its
configured model. This is harness interoperability evidence, not a Claude-model
or performance benchmark.


### Repeated product handoffs

Set `DISCLAUDE_E2E_BROWSER_STRESS=1` to exercise 100 sequential IPC callers against
the same externally deployed page. Each caller verifies the preceding value,
writes its own value, and reads it back. An independent final caller verifies
the last value. This uses the actual product service/browser/workers and no model
credentials. Browser CI enables it on Linux; local runs can opt in explicitly.

On macOS ARM64 with Chromium 155.0.8057.0 and Node 24.8.0 (2026-09-17), all 100
handoffs passed in 73.87 seconds. Grant-wait observations were p50=410ms,
p95=424ms, max=471ms. The full product lifecycle test, including interruption,
broker crash, restart and cleanup, passed in 89.73 seconds; its private root was
removed. These are observations from one run, not latency guarantees. This loop
does not itself prove queue contention; the separate two-agent case covers that.

Linux CI also passed the 100-caller case on source `c5628c2a`: Ubuntu 24.04.5,
Node 24.20.0 and Google Chrome 152.0.7977.82. The loop took 79.78 seconds;
grant wait was p50=436ms, p95=454ms, max=507ms. The log confirms all previous
states, reclamation ordering, independent readback and root removal. All three
browser product cases passed in 140.96 seconds. See
[run 35138008609](https://github.com/hs3180/disclaude/actions/runs/35138008609),
[job 104935142242](https://github.com/hs3180/disclaude/actions/runs/35138008609/job/104935142242).
This runner evidence does not replace Docker/native service installation,
authenticated-site login or actual deployment-machine acceptance.

### Two real agents competing for the browser

Set `DISCLAUDE_E2E_BROWSER_CONTENTION_MODEL` to an accessible Anthropic-compatible
model when running `tests/e2e/browser-service.test.ts`, with the Chromium/Python
prerequisites above, model credentials supplied through environment variables,
and an isolated `CLAUDE_CONFIG_DIR`. No model calls are added to credential-free
CI. The deployment fixture selects the real Claude backend and model.

The standalone `scripts/test-browser-contention.mjs` process sends two independent
chats to the running deployment's `POST /api/chat/sync`. It imports no providers
or agent implementation and supplies no fake delivery adapter. Explicit commands
isolate arbitration from open-ended planning or model quality. The service owns
normal message routing, agent creation, model execution and response delivery.

Agent A writes a local page draft and holds its lease. Only after observing that
hold does the client start B. The public browser status must report B queued while
A still owns control, and B's execution marker must remain absent. The client
releases A; B then verifies A's text and updates it.
The client checks both real REST responses, B's execution marker, and the final
value through an independent browser-use invocation. An early-ending model request
fails promptly rather than waiting for a browser marker that cannot arrive.

The JSON `BROWSER_MODEL_CONTENTION` report includes pass/fail, two chat IDs,
completed checks, observed queue wait, duration and fixture-cleanup status. On
failure the client releases its gate and attempts the public stop command for
both chats. The deployment owner must still stop/join its service before deleting
the workspace; a stop acknowledgement is not an OS-descendant exit guarantee.

For an already prepared test deployment on the same host/shared filesystem:

```sh
node scripts/test-browser-contention.mjs \
  --service-url http://127.0.0.1:PORT \
  --workspace /absolute/test-workspace
```

The managed page must already contain `<input id="value">`. The client does not
start/stop the deployment itself. Use an isolated test workspace and model config.

On macOS ARM64/Node24.8.0, the external REST case with two real Claude-backend
`deepseek-flash` tasks passed in27.523s; the enclosing lifecycle/crash/restart
case passed in41.980s. B queued for703.55ms. Service/browser callers and tracked
crash descendants closed; test and private model-config roots were removed.
The first attempt had an early model failure before A acquired the browser;
isolating Claude configuration and rebuilding the exact branch preceded the
successful run. The failed attempt was not counted as acceptance, and its retained
private config was removed after confirming no process referenced it.

This replaces the earlier direct-provider evidence for the two-agent case.
It remains a controlled draft task on one provider/platform, not simultaneous
browser access, a natural-language benchmark, model-created subagents, or Feishu
interaction. The ordinary-agent external REST case is maintained separately in
#5059; it is not duplicated in this change. Other legacy provider cases need
separate externalization (#5016).

An unavailable-deployment failure probe also exited1 in142ms with a structured
failed report; its owned fixture was removed. After synchronizing main, build and
focused TypeScript/lint checks passed; product runtime packages were unchanged
from the successful external model run.

### Test-resource cleanup

The product browser E2E waits for its service and caller processes to close and
for explicitly tracked crash-fixture descendants to disappear before removing its
private profile/workspace. Cleanup attempts all three resource groups even if one
fails; an unconfirmed exit retains the root with a diagnostic. Ordinary directory
contention gets bounded retries. Setup failures before starting the service also
remove the owned root.

To exercise teardown while a real browser invocation is active, run the existing
case with `DISCLAUDE_E2E_BROWSER_FAIL_DURING_CALL=1` and the same Chromium/Python
paths. This deliberately fails the test: require the injected-failure diagnostic,
`BROWSER_SERVICE_CLEANUP`, and independent confirmation that the printed
`BROWSER_SERVICE_TEST_ROOT` is absent. A nonzero exit by itself is not successful
cleanup evidence. This does not test killing the entire Vitest process or reclaiming
external launchd/systemd/Docker resources (#5049).
