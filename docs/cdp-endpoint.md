# Docker Chromium service-internal CDP endpoint

> This document describes the Docker browser service's internal wiring and
> operator diagnostics only. It is not an Agent interface. Agent processes must
> use the private IPC launcher described in `docs/browser-coordination.md` and
> must not receive `BU_CDP_URL`, `BU_CDP_WS`, `CDP_PORT`, or connect directly to
> CDP. The former Agent-level direct-CDP instructions were removed from the
> 0.6.0 path.

> Issue #4496 (service wiring). This page records the **service-internal**
> side of the CDP contract: the containerized Chromium and its nginx front. It
> is not a browser-use Skill or Agent configuration guide. Current Agent access
> is the private IPC launcher described in `docs/browser-coordination.md`.

## Decision: reuse the existing Chromium CDP service (Scope-5)

**We reuse the existing `disclaude-chromium` compose service. No new
browser-use-native container is introduced.**

Rationale (all verifiable in this repo today):

| #4496 requirement | Satisfied by existing infra |
|---|---|
| Dockerized headless Chromium, deps baked into image, no host packages | `mcr.microsoft.com/playwright:v1.62.0-noble` — the official image bundles Chromium + all shared libs (docker-compose.yml, `chromium` service); pinned to the Scope-6 smoke-tested version (Playwright 1.62.0 / chromium-1234 / Chromium 151.0.7922.34, #4528) |
| Stable, cross-driver CDP endpoint | nginx-fronted endpoint at `CDP_PORT` (#4151 rationale), source-aware Host rewriting for container vs host clients (#4164) |
| Liveness signal | compose healthcheck probing `GET /json/version` **through nginx** (#4099), so it catches both Chrome dying and proxy failure |

Starting a second, browser-use-specific container would duplicate this stack
and reintroduce the version-drift problem #4496 was opened to avoid. The
coordinator may use this service as an internal browser transport; Agent
processes do not receive this endpoint or attach to it directly.

## Endpoint contract

Bring-up (optional compose profile):

```bash
docker compose --profile chromium up -d
```

The endpoint is then reachable only by the configured service/operator path at:

| Client location | URL | Notes |
|---|---|---|
| Peer container on the Docker network | `http://disclaude-chromium:${CDP_PORT:-9222}` | default `9222` |
| Host (user-scope MCP clients) | `http://localhost:${CDP_PORT:-9222}` | published on **loopback only** (`127.0.0.1:` binding) |

- `GET /json/version` — plain HTTP, returns browser metadata + `webSocketDebuggerUrl`.
- WS upgrade — per-target CDP socket. nginx performs the HTTP→WebSocket
  upgrade; Chrome's DNS-rebinding Host check is satisfied by the proxy's Host
  rewrite (`docker/chromium-cdp-nginx.conf` header comment documents both
  Chrome 148+ quirks and why a plain TCP forwarder like socat fails).
- Service-internal env knobs (`.env`): `CDP_PORT` (external, default 9222), `CDP_INTERNAL_PORT`
  (Chrome loopback listener, default 9221 — **must differ** from `CDP_PORT`),
  `CHROMIUM_IMAGE_TAG`.

Do not copy either URL or these port variables into an Agent environment. In
coordinated mode the service owns the endpoint and `browserAgentEnv()` removes
the direct-CDP variables before creating an Agent subprocess.

## Current Agent boundary

Agents use the private IPC launcher and socket from
`docs/browser-coordination.md`. They must not receive `BU_CDP_URL`, `BU_CDP_WS`,
`CHROMIUM_CDP_*`, `CDP_PORT`, or a direct browser endpoint. The browser-use
Skill is intentionally written around that launcher; it does not configure or
start an upstream daemon itself.

An existing-browser deployment may keep `BU_CDP_URL` in the **service-only**
configuration. That value is consumed by the coordinator and must not cross the
Agent environment boundary. If the coordinator is unavailable, browser calls
fail explicitly; they do not fall back to direct CDP, self-launch an upstream
daemon, or replay an unknown operation.

## Sandbox policy (Scope-4)

Current, explicit tradeoff recorded here:

- Chrome runs with `--no-sandbox --disable-setuid-sandbox`
  (`docker-compose.yml`, `chromium.command`). This is **not** an oversight —
  it avoids seccomp/AppArmor friction on arbitrary headless hosts — but it is
  compensated by container-level confinement:
  - The CDP port is published **loopback-only** (`127.0.0.1:${CDP_PORT}`). CDP
    is unauthenticated and exposes the live browser session (pages, JS
    context, network); loopback binding means no LAN host can drive it.
  - Dedicated optional compose profile (`--profile chromium`) — the browser
    only runs where explicitly enabled.
  - Resource limits: 1 CPU / 2 GB RAM ceiling, 0.25 CPU / 256 MB reservation.
  - `--disable-dev-shm-usage`, network/extension/sync hardening flags.
- **Accepted risk**: inside the container, a Chromium renderer compromise is
  unsandboxed. Given the endpoint is loopback-confined and the profile is
  opt-in, this matches the maturity of the current deployment.
- **Future hardening path** (not done in this PR): a seccomp/AppArmor profile
  + dropping `--no-sandbox`, or `--cap-add=SYS_ADMIN` as an intermediate step.
  Revisit if the endpoint is ever published beyond loopback.

## Acceptance status

- [x] Scope-5 service reuse decision — recorded above (part 1, #4506)
- [x] Service-internal CDP policy and diagnostics — this page (part 1, #4506)
- [x] Optional: Playwright attaching to the same endpoint as a second driver
  (case 6 — cross-driver reuse confirmed, config-only as designed)
- [x] README records the current Agent boundary and coordinator entry —
  `README.md` → "Browser on Headless Hosts (coordinated service)" (part 3)

## Agent-level e2e harness (#4602)

The Agent-level harness uses the same coordinated IPC path as production. Run
it only with `DISCLAUDE_BROWSER_SOCKET` and the private launcher configured; it
does not accept a CDP URL or expose a browser port to the Agent. Its failure
case overrides one disposable IPC socket and verifies an explicit broker error.
The assertion core is unit-tested in CI
(`packages/service/src/testing/browser-use-e2e.test.ts`).

```bash
npx tsx scripts/browser-use-agent-e2e.mts --workspace <workspace-dir>
```

## Related

- #4496 — service endpoint contract; #4460 — browser-use Skill
  (current Agent access is the coordinated IPC path)
- #4151 nginx CDP proxy · #4164 host-scope CDP · #4099 healthcheck
- Implementation files: `docker-compose.yml` (`chromium` service),
  `docker/chromium-cdp-nginx.conf`, `.env.example`

### Smoke isolation and failure validity (0.6.0)

Each `scripts/browser-use-smoke.sh` run creates a private daemon namespace and
runtime directory, ignoring inherited `BU_NAME`/`BH_*` paths. It creates its own
target explicitly: `new_tab(url)` can reuse a pre-existing blank tab, and the
horse title marker identifies an attached target, not the visible tab. DOM and
screenshot checks reattach to the recorded target ID; cleanup verifies that
only this target disappeared before switching endpoints.

Case 6 requires successful reload **and** a read-only IPC/PID-file assertion
that the daemon is stopped. The same assertion runs after the dead-endpoint
probe. Timeout/command/signal exits (124 and above), a zero exit, or execution
of the success marker fail the test. Healthy checks also require exit zero;
printing a marker before a crash no longer passes.

Set `SMOKE_PYTHON` to the interpreter that imports `browser_harness` when it is
not the default `python3`. GNU `timeout`/`gtimeout` is used when available;
otherwise the bundled POSIX Python wrapper bounds commands and cleans up their
process group. Failed daemon cleanup retains its private runtime directory for
diagnosis. `SMOKE_OUT_DIR` may contain spaces/quotes; screenshot paths are passed
through the environment rather than embedded in Python code.

Whole-host Chrome process counts are not browser ownership evidence on a
normal desktop. Case 2b is opt-in via `SMOKE_ASSERT_PROCESS_COUNT=1` for isolated
service containers only. Discovery does not prove an intended browser/profile;
record the service identity and version separately for release acceptance.

`tests/e2e/browser-smoke.test.ts` runs this diagnostic against an independently
launched temporary browser/profile, verifies all seven enabled assertions and
the PNG signature, and stops the browser afterward. Set
`DISCLAUDE_E2E_CHROMIUM` to the browser executable and
`DISCLAUDE_E2E_BROWSER_PYTHON` to the interpreter whose adjacent `browser-use`
CLI is installed, then run
`node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts tests/e2e/browser-smoke.test.ts`.
The Browser Coordination E2E workflow includes it with pinned Python packages.
This is standalone CLI compatibility evidence; the separate product service
test covers coordinated Agent access. Whole-host process counting remains
skipped because this fixture hosts the browser itself.

Local macOS validation on 2026-09-14 used a dedicated temporary Chromium
155.0.8057.0 process/profile and the installed harness reporting 0.1.13. The
matrix passed seven assertions, with desktop process counting explicitly
skipped; PNG, target removal, and daemon shutdown passed. Linux/Docker real
runtime evidence remains required under #4625/#4800; local fake-process tests
verify failure classification and are not cross-platform browser evidence.
