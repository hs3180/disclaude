# CDP Endpoint — Headless Chromium Contract

> Issue #4496 (part 1, docs). This page defines the **endpoint side** of the CDP
> contract: the containerized headless Chromium that any browser driver
> (browser-use CLI, Playwright, Playwright MCP) attaches to via
> `connect_over_cdp` / `--cdp-endpoint` / CDP env config. The **skill side**
> (how the browser-use Skill reads config and attaches) is #4460.
> Part 2 (Scope-6 smoke acceptance results) is recorded further down this page.

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
browser-use CLI is a **CDP client**, not a browser vendor — it attaches to the
same endpoint like any other driver.

## Endpoint contract

Bring-up (optional compose profile):

```bash
docker compose --profile chromium up -d
```

The endpoint is then reachable at:

| Client location | URL | Notes |
|---|---|---|
| Peer container on the Docker network | `http://disclaude-chromium:${CDP_PORT:-9222}` | default `9222` |
| Host (user-scope MCP clients) | `http://localhost:${CDP_PORT:-9222}` | published on **loopback only** (`127.0.0.1:` binding) |

- `GET /json/version` — plain HTTP, returns browser metadata + `webSocketDebuggerUrl`.
- WS upgrade — per-target CDP socket. nginx performs the HTTP→WebSocket
  upgrade; Chrome's DNS-rebinding Host check is satisfied by the proxy's Host
  rewrite (`docker/chromium-cdp-nginx.conf` header comment documents both
  Chrome 148+ quirks and why a plain TCP forwarder like socat fails).
- Env knobs (`.env`): `CDP_PORT` (external, default 9222), `CDP_INTERNAL_PORT`
  (Chrome loopback listener, default 9221 — **must differ** from `CDP_PORT`),
  `CHROMIUM_IMAGE_TAG`.

### Pointing drivers at the endpoint (Acceptance-①)

```bash
# Playwright (library)
chromium.connectOverCDP("http://disclaude-chromium:9222")

# browser-use CLI / Skill — see config contract below
BU_CDP_URL=http://disclaude-chromium:9222 browser-use ...
```

> The Playwright MCP driver entry (`tools.mcpServers.playwright`) was **removed** in
> #4460's final part — disclaude no longer consumes the endpoint over MCP; the
> browser-use Skill (`BU_CDP_URL`) is the in-repo consumer. The endpoint itself is
> unchanged and any external CDP client (Playwright library included) still attaches.

## Skill ↔ CDP configuration contract (Scope-3, the #4460 interface face)

The browser-use Skill must **not** hard-code a self-launched Chromium path.
It attaches to an external CDP endpoint when one is configured, and falls back
to native self-launch otherwise (#4460's default behavior stays available).

**Configuration entry points** (checked in this priority order; at least the
env var is required — recommended for containerized injection):

1. `BU_CDP_URL` — env var. Accepts the HTTP endpoint form (`http://host:port`)
   or a direct WebSocket debugger URL (`ws://host:port/...` — the form
   `skills/browser-use/SKILL.md` currently shows). Preferred entry point;
   compose/systemd can inject it without touching skill flags. Which form the
   browser-use CLI accepts end-to-end is pinned by the Scope-6 smoke run.
2. `BU_CDP_WS` — env var, direct WebSocket debugger URL
   (`ws://host:port/devtools/browser/<uuid>`), for clients that already hold a
   resolved `webSocketDebuggerUrl` from `/json/version`.
3. Skill config field — same URL forms as above; lowest priority so env
   injection wins in containers. The pre-3.0 `--cdp-url` CLI flag is **not**
   a live entry point (removed upstream; it became the `BU_CDP_URL` env var —
   see `skills/browser-use/SKILL.md`); the skill-side config field is what
   fulfills this slot and is wired in #4460.

**Behavioral semantics:**

- Any of the above set → the skill **attaches** to the external Chromium and
  must **not** spawn its own browser process.
- None set → fall back to native self-launch (portable default, unchanged
  from #4460).
- Attach failure is a hard error (report the endpoint URL + `/json/version`
  result), **not** a silent fallback to self-launch — a silent fallback would
  mask a dead container and produce "works but wrong browser" sessions.

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

## Scope-6 smoke acceptance — executed (part 2)

The contract above was exercised end-to-end on a live headless deployment
(2026-08-16; Debian 12 headless container, no desktop). Because that host had
no Docker daemon, the **endpoint process** was brought up as a bare
`--headless=new` Chromium rather than via `docker compose --profile chromium`
— the same Chrome binary family the compose service runs (Playwright-bundled
Chromium 151, `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage
--remote-debugging-port=<port> --user-data-dir=<dedicated dir>`), i.e. the
container's command line minus the nginx front. **The nginx-fronted compose
endpoint itself still needs one confirmation run on a Docker-capable host**;
the driver-side matrix below is independent of that front (it binds to
`127.0.0.1:<port>` exactly like Chrome's loopback listener does inside the
container).

Versions under test: `browser-use` CLI 0.13.7 (`browser-harness` 0.1.8),
Playwright-bundled Chromium 151.0.7922.34 (playwright pin `chromium-1234`),
Playwright (Python) 1.62.0.

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | `BU_CDP_URL=http://127.0.0.1:<port>` → browser-use attaches, **no self-spawn** | ✅ | `ps` shows exactly the one pre-started Chromium process tree; `BROWSER_KIND="cdp"` (`browser_harness/daemon.py:90`); `new_tab("https://example.com")` + `js("document.title")` → `Example Domain` |
| 2 | Script-injection round-trip (owner's core ask) | ✅ | `new_tab("data:…<script>window.marker=42</script>")`; `js()` returns `document.getElementById('x').textContent` → `hello-cdp`; `js("JSON.stringify({m: window.marker, computed: [1,2,3].map(i=>i*2)})")` → `{"m":42,"computed":[2,4,6]}` |
| 3 | Screenshot round-trip | ✅ | `capture_screenshot("/tmp/smoke-shot.png")` → PNG written, 1907 bytes |
| 4 | `BU_CDP_WS=ws://…/devtools/browser/<uuid>` (resolved from `/json/version`) | ✅ | Same attach + `document.title` round-trip via the WS form |
| 5 | Attach failure = **hard error**, no silent fallback | ✅ | `BU_CDP_URL=http://127.0.0.1:<dead-port>` → CLI exits fatal after 30s: `BU_CDP_URL=… unreachable after 30s: Connection refused` — no self-launched browser |
| 6 | Playwright as second driver on the **same** endpoint (optional acceptance) | ✅ | `chromium.connect_over_cdp("http://127.0.0.1:<port>")` → `page.title()` = `Example Domain`, `evaluate("1+1")` = `2`; Playwright then **sees the tabs browser-use opened** (shared-browser proof: `['https://example.com/' × 3]`) |

Two operational notes confirmed during the run:

- **`http://` vs `ws://` in `BU_CDP_URL`** — both work: the daemon resolves the
  HTTP form to a WS URL via `GET /json/version` (`browser_harness/daemon.py`,
  `get_ws_url`). The contract in Scope-3 stands as written.
- **Fallback path** — with neither `BU_CDP_URL` nor `BU_CDP_WS` set, the CLI
  attempts native self-launch (a local profile-scoped Chrome); on this
  shared-libs-fragile host that path is exactly the fragility #4496 exists to
  avoid, which is the empirical argument for preferring the endpoint on
  headless hosts.

A third note, confirmed on the macOS re-run (2026-08-25, browser-use 0.13.8 /
browser-harness 0.1.9 — same driver-side matrix, 5/6 green; the compose-front
case stays environment-blocked):

- **The daemon pins the attach target from its *first-start* environment** —
  `BU_CDP_URL`/`BU_CDP_WS` are read once by the long-lived daemon
  (`browser_harness/daemon.py:90`, `get_ws_url`), and later CLI invocations
  just connect to the daemon over its unix socket (`_ipc.py`), never
  re-reading the env. Practical consequence: **changing `BU_CDP_URL` between
  invocations is silently ignored** while the old daemon lives. This is also a
  *test-validity* trap — re-running the "dead endpoint fails hard" case
  (matrix case 5) against a daemon that already holds a healthy connection
  **passes vacuously**: the run succeeds, exit 0, and proves nothing. Verified:
  dead-`BU_CDP_URL` invocation against a live daemon returned `page_info()`
  from the healthy session; only after `browser-use --reload` (kills the
  daemon) did the same invocation exit 1 with
  `BU_CDP_URL=… unreachable after 30s`. Rule: when the endpoint env changes,
  `browser-use --reload` first (or set `BU_NAME` per endpoint so each gets its
  own daemon socket).

### nginx-fronted compose endpoint — confirmed (2026-08-27, #4496 final box)

The one outstanding item — the same matrix through the **nginx-fronted compose
endpoint** rather than a bare loopback listener — was executed from the
disclaude **primary container itself** (a peer container on the compose Docker
network), which exercises exactly the path the bare-listener run could not:

- Endpoint: `http://disclaude-chromium:9222` — the compose default
  (`BU_CDP_URL` as promoted into tracked `docker-compose.yml`), reached as a
  **peer container by container DNS name**, i.e. the nginx Host-rewrite path
  (`Server: nginx/1.24.0` on `GET /json/version`, non-IP `Host:` header
  accepted → Chrome's DNS-rebinding check satisfied by the proxy).
- Image: the compose default pinned by #4528 —
  `mcr.microsoft.com/playwright:v1.62.0-noble` → Chromium **151.0.7922.34**
  (`/json/version` "Browser" field), i.e. **identical to the Scope-6
  smoke-tested version** — the version-delta caveat #4528 existed for does not
  apply to the confirmed configuration.
- Client: browser-use CLI 0.1.9 (`browser-harness` 0.1.9), same family as the
  macOS re-run; each case used a **fresh `BU_NAME` daemon** so no case
  inherited a prior daemon's attach target (the vacuous-pass trap recorded
  above).

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | Peer-container attach via compose DNS name, **no self-spawn** | ✅ | `new_tab("https://example.com")` + `js("document.title")` → `Example Domain`; `ps` in the client container shows **zero local Chrome processes** |
| 2 | Script-injection round-trip through nginx | ✅ | `new_tab("data:…<script>window.marker=42</script>")`; `js()` → text `hello-cdp`, `{"m":42,"computed":[2,4,6]}` |
| 3 | Screenshot round-trip through nginx | ✅ | `ensure_real_tab()` + `capture_screenshot(path=…)` → PNG (magic bytes `\x89PNG`), 15231 bytes |
| 4 | `BU_CDP_WS` WS form resolved through the nginx front | ✅ | `/json/version` → `webSocketDebuggerUrl` (ws://…/devtools/browser/…) → attach + `document.title` → `Example Domain` — the **WS upgrade through nginx** works, not just plain HTTP |
| 5 | Attach failure = **hard error**, no silent fallback | ✅ | `BU_CDP_URL=http://disclaude-chromium:9223` (dead port) in a fresh daemon → exit 1 after 30s: `unreachable after 30s: Connection refused` — no self-launched browser |
| 6 | Shared-browser across independent client sessions | ✅ | A second, separate daemon session `list_tabs()` sees the first session's tabs (`cdp-confirm`, `Example Domain` ×N) — same cross-client sharing the Playwright case proved driver-side |

Notes from the run:

- **Case-3 detail**: `capture_screenshot` against a `data:` tab that the
  harness considers inactive raises `Not attached to an active page`; the
  skill's `ensure_real_tab()` activation first (per
  `skills/browser-use/SKILL.md`) makes the same call succeed. Not a
  contract issue — a usage prerequisite like the #4600 `mkdir` one.
- **Nginx-front specifics confirmed**: Host rewrite (container-DNS `Host:`
  header accepted where a direct Chrome listener would 500), HTTP→WS upgrade
  (case 4), and plain-HTTP metadata (`/json/version`) all work through the
  proxy — the front adds no contract-visible behavior beyond making the
  endpoint reachable, which is exactly its design goal.

With this, every environment-blocked acceptance item of #4496 has now been
executed: the driver-side matrix (part 2) and the compose-fronted endpoint
(this run) agree on all cases.

## Acceptance status

- [x] Scope-5 reuse decision — recorded above (part 1, #4506)
- [x] Scope-2/3/4 contract + policy docs — this page (part 1, #4506)
- [x] Scope-6 smoke acceptance — driver-side matrix above (part 2; nginx-front
  confirmation run executed 2026-08-27, see the compose-endpoint section
  above — all 6 cases ✅)
- [x] Optional: Playwright attaching to the same endpoint as a second driver
  (case 6 — cross-driver reuse confirmed, config-only as designed)
- [x] README records the endpoint: driver/skill attach URLs (①), skill CDP
  config entry + attach/fallback semantics (②), sandbox tradeoff (③) —
  `README.md` → "Browser on Headless Hosts (CDP Endpoint)" (part 3), linking
  here for the full contract

## Related

- #4496 — this contract (endpoint side); #4460 — browser-use Skill (skill side)
- #4151 nginx CDP proxy · #4164 host-scope CDP · #4099 healthcheck
- Implementation files: `docker-compose.yml` (`chromium` service),
  `docker/chromium-cdp-nginx.conf`, `.env.example`
