# Docker Chromium service-internal CDP endpoint

> This document describes the Docker browser service's internal wiring and
> Operator diagnostics only. This page describes the container service's
> internal browser transport, not an Agent interface. Agent processes use the
> private IPC launcher described in `docs/browser-coordination.md` and must not
> receive `BU_CDP_URL`, `BU_CDP_WS`, `CDP_PORT`, or connect directly to CDP.

## Browser service

**We reuse the existing `disclaude-chromium` compose service. No new
browser-use-native container is introduced.**

The existing service provides the required shared browser endpoint:

| Requirement | Current implementation |
|---|---|
| Browser and dependencies in a container | Official Playwright browser image, selected by `CHROMIUM_IMAGE_TAG`. |
| Stable CDP endpoint for service-side callers | nginx proxy with host-aware routing and WebSocket upgrade support. |
| Liveness | Compose healthcheck probes `GET /json/version` through nginx. |

Starting a second, browser-use-specific container would duplicate this stack
and introduce a second browser version to maintain. The coordinator may use
this service as an internal transport; Agent processes do not receive this
endpoint or attach to it directly.

## Endpoint contract

Bring-up (optional compose profile):

```bash
docker compose --profile chromium up -d
```

The endpoint is then reachable only by the configured service/operator path at:

| Client location | URL | Notes |
|---|---|---|
| Peer container on the Docker network | `http://disclaude-chromium:${CDP_PORT:-9222}` | default `9222` |
| Host (operator diagnostics) | `http://localhost:${CDP_PORT:-9222}` | published on **loopback only** (`127.0.0.1:` binding) |

- `GET /json/version` — plain HTTP, returns browser metadata + `webSocketDebuggerUrl`.
- WS upgrade — per-target CDP socket. nginx performs the HTTP→WebSocket
  upgrade; Chrome's DNS-rebinding Host check is satisfied by the proxy's Host
  rewrite (`docker/chromium-cdp-nginx.conf` header comment documents both
  Chrome 148+ quirks and why a plain TCP forwarder like socat fails).
- Service-internal env knobs (`.env`): `CDP_PORT` (external, default 9222), `CDP_INTERNAL_PORT`
  (Chrome loopback listener, default 9221 — **must differ** from `CDP_PORT`),
  `CHROMIUM_IMAGE_TAG`.

Do not copy either URL or these port variables into an Agent environment. When
the coordinator is configured, the service owns the endpoint and `browserAgentEnv()` removes
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

## Sandbox boundary

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
- If the endpoint is ever published beyond loopback, revisit browser
  authentication and container sandboxing before changing the exposure.

## Agent-level e2e harness

The Agent-level harness uses the same coordinated IPC path as production. Run
it only with `DISCLAUDE_BROWSER_SOCKET`; the private launcher is resolved
relative to the socket automatically. It does not accept a CDP URL or expose a
browser port to the Agent. Its failure case overrides one disposable IPC socket
and verifies an explicit broker error.
The assertion core is unit-tested in CI
(`packages/service/src/testing/browser-use-e2e.test.ts`).

```bash
npx tsx scripts/browser-use-agent-e2e.mts --workspace <workspace-dir>
```

## Implementation

The container service and proxy are defined in `docker-compose.yml` and
`docker/chromium-cdp-nginx.conf`; the service image is built from
`docker/Dockerfile.chromium`.
