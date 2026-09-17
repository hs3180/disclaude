# Browser chat acceptance through an external client — 2026-09-17

The ordinary-agent case now runs `scripts/test-browser-chat-agent.mjs` as a
separate Node process against a running Disclaude deployment. It sends a unique
chat to `POST /api/chat/sync`; it does not import `AgentFactory`, `ChatAgent`,
providers, or configuration singletons, and supplies no fake delivery adapter.
The deployment owns its normal message routing, agent creation, model execution,
and REST response. This replaces the earlier in-process evidence for this case.

The enclosing lifecycle fixture starts the actual CLI with Feishu disabled and a
loopback REST port, an isolated workspace/profile, and the selected model backend.
It injects `BU_CDP_URL` and `BU_CDP_WS` markers through service configuration and
`CHROMIUM_CDP_PORT=9223` through the service environment. Managed-browser startup
has empty direct-CDP environment settings, because a managed binary and an
external CDP endpoint are mutually exclusive. This case therefore proves removal
of configured CDP URLs and an inherited port, not an inherited direct-CDP URL.

The model executes a shell probe and writes a unique marker through `browser-use`.
The probe records only five non-secret browser fields in the real tool process
and an ordinary Node child. All three stale CDP fields must be absent and the
service-owned IPC socket/bin must match. The external client checks the actual
REST reply, then independently invokes the deployment's `browser-use` executable
to read the marker back from the shared page.

## Actual validation

macOS ARM64, `deepseek-flash`, actual model credentials and managed Chromium:

| Deployment backend | External REST/browser case | Full browser lifecycle |
| --- | --- | --- |
| Claude SDK | Passed, 10.482 s | Passed, 27.002 s |
| dsh (`deepseek`) | Passed, 8.242 s | Passed, 22.823 s |

Both runs verified crash recovery, service stop/restart, caller termination,
tracked descendant termination, and owned-root removal. Private model-config
roots were also removed. Production Feishu service/configuration was untouched.
Build and focused TypeScript checks passed. No claim is made that these model
cases run in credential-free CI.

## Run and report

Set `DISCLAUDE_E2E_CHROMIUM`, `DISCLAUDE_E2E_BROWSER_PYTHON`, and
`DISCLAUDE_E2E_BROWSER_CHAT_AGENT_MODEL`. Backend defaults to `deepseek`; select
Claude with `DISCLAUDE_E2E_BROWSER_CHAT_AGENT_BACKEND=claude`. Provide credentials
through the selected backend's environment, with isolated `DSH_HOME` and/or
`CLAUDE_CONFIG_DIR`. The test generates its own service config and browser markers.
Run `node node_modules/vitest/vitest.mjs run tests/e2e/browser-service.test.ts`.

To access an already prepared test deployment directly:

```sh
node scripts/test-browser-chat-agent.mjs \
  --service-url http://127.0.0.1:PORT \
  --workspace /absolute/test-workspace \
  --socket /absolute/test-workspace/browser.sock
```

This case requires the client and deployment to share the test workspace and
executable paths. Prepare a shared page containing `<input id="value">` first.
The standalone client does not launch or stop the deployment itself. Run it on
the deployment host (or in the same mounted test environment), not against a
production bot or an unrelated workspace.

`BROWSER_CHAT_AGENT_ENTRY` emits a JSON result with pass/fail, entry, configured
backend, unique chat ID, completed checks, duration and fixture-cleanup status.
On an incomplete request it attempts the public stop command and leaves probe
files for the deployment owner, which must stop and join the isolated service
before removing the workspace. An HTTP stop acknowledgement alone is not proof
that arbitrary model descendants have exited. The lifecycle fixture performs
that service shutdown before its resource cleanup.

## Remaining boundaries

This is a bounded explicit-command acceptance case, not a planning benchmark,
model-created subagent test, Feishu/card acceptance, remote-filesystem test, or
hostile-agent sandbox. The other legacy provider/contention paths in the browser
suite still need the separate external-process refactoring tracked by #5016 and
#5054. This change does not claim the entire E2E suite has been converted, or close
#5014 and the remaining 0.6.0 deployment/UX gates.
