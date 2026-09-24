# Chromium in Docker

Build and start the optional browser service:

```sh
docker compose --profile chromium build chromium
docker compose --profile chromium up -d chromium
```

The browser image preinstalls nginx, Xvfb, optional noVNC components and
network/readiness utilities, so starting an already built image does not run apt
or require package mirrors.
`CHROMIUM_IMAGE_TAG` selects the official Playwright browser distribution used
as its base; rebuild when changing it. The service image is named
`disclaude-chromium:<tag>`. This does not install or select a Playwright agent.

Default execution uses Chromium with Xvfb at 1920×1080. Set
`CHROMIUM_HEADLESS=1` for the headless alternative. The process supervisor stops
the browser/proxy/display together if any exits. Compose enables an init process
and retains the existing loopback-only host port and nginx CDP routing contract.

The dedicated `chromium_profile` volume is mounted at `/data/chrome-profile`.
Normal restarts and container recreation preserve it; `docker compose down -v`
removes volumes and must not be used when retaining browser state. The profile
belongs to the container browser and does not reuse a host daily Chrome profile.
An existing `/tmp/chrome-cdp` profile is not automatically migrated: stop the old
browser cleanly and back up its profile before removing/recreating that container.
Retain the backup when trying a copy with a newer browser; copying profile files
does not prove login cookies can be decrypted across browser applications.

Defaults: `CHROMIUM_MEMORY=4G`, `CHROMIUM_SHM_SIZE=2gb`, `TZ=Asia/Shanghai`,
`CHROMIUM_LANG=C.UTF-8`, `CHROMIUM_ACCEPT_LANG=en-US,en`.
`CHROMIUM_LANG` sets the process locale; it does not configure browser content
languages. `CHROMIUM_ACCEPT_LANG` is passed to Chromium
[`--accept-lang`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/chrome_switches.h),
which controls Accept-Language and the JavaScript language properties. Set it to
a comma-separated language list such as `zh-CN,zh` for a Chinese-language deployment.
Chromium may expose only the primary language in `navigator.languages`.
This is a browser startup setting; no profile preferences are rewritten by the
entrypoint. Override these for the deployment environment. Chromium
still runs as root with `--no-sandbox` inside this image, matching the prior
container boundary; it is not a sandbox for untrusted agent code. No guarantee
of third-party anti-bot acceptance, GPU renderer, or site login persistence is
made by enabling headed mode.

## One-time manual verification (optional)

For a site that presents a visible verification page, use the tracked Compose
override to expose a temporary, password-protected noVNC view of the same headed
browser. The normal Compose file does not publish a VNC port and leaves this
feature disabled.

Set an exactly 8-character printable ASCII password through a secret manager or
the environment, then start the override:

```sh
export CHROMIUM_VNC_PASSWORD='Ab3!xY7?'
export CHROMIUM_VNC_BIND=0.0.0.0
export CHROMIUM_VNC_HOST_PORT=6080
docker compose -f docker-compose.yml -f docker-compose.chromium-vnc.yml \
  --profile chromium up -d --build chromium
```

Open this URL from the same LAN, replacing `<browser-host>` with the Docker host:

```text
http://<browser-host>:6080/vnc.html?autoconnect=true&resize=scale&reconnect=true
```

Enter the password when noVNC asks for it. Navigate the existing CDP browser to
the target site and complete only the visible human verification. Do not
automate CAPTCHA input, record the password, or publish the CDP port. On macOS
Docker/Colima, publish the VNC port on `0.0.0.0` rather than pinning it to a
specific host interface if the backend rejects that interface address.

After the article is readable, stop the override cleanly so Chromium flushes its
profile:

```sh
docker compose -f docker-compose.yml -f docker-compose.chromium-vnc.yml \
  --profile chromium stop chromium
```

The `chromium_profile` volume is intentionally retained. Reusing it can avoid a
second verification while its cookies/session remain valid, but it is a
single-owner profile: never start a second Chromium against the active profile,
and stop the first browser gracefully before handing the profile to another
process. This is an assisted bootstrap, not an automatic challenge bypass; a
site may challenge the profile again after session expiry or a network/context
change.

Acceptance must include CDP discovery **and WebSocket operations**, a test page,
PNG capture, actual browser/display processes and profile persistence after
container recreation. Use the smoke matrix in `docs/cdp-endpoint.md` for driver
behavior and record native Linux and Docker platform/architecture separately.
Full application/channel/API container migration remains tracked by #4924;
this browser-only image does not establish that acceptance.

The supervisor requests `Browser.close` over the browser's internal loopback CDP
connection before terminating remaining children, allowing persistent state to
flush. Compose gives shutdown 15 seconds. If CDP is unresponsive, bounded process
termination remains the fallback; forced kills cannot promise pending writes
were committed.

Run the opt-in acceptance against a locally built image (Node 22+ and Docker):

```sh
docker build -t disclaude-chromium:060-test -f docker/Dockerfile.chromium docker
node scripts/test-chromium-container.mjs disclaude-chromium:060-test
```

It creates uniquely named disposable containers and a dedicated volume, verifies
host-advertised CDP WebSocket routing, DOM, PNG, target cleanup, Xvfb/headless
process identity, persistent Cookie retention after recreation, and supervisor
shutdown after proxy failure. Its `finally` cleanup removes only those test
containers and that volume. No real account or production profile is used.

On 2026-09-14 this passed on a Linux/aarch64 Docker engine hosted on macOS, using
the pinned image's Chromium 151.0.7922.34, in both headed/Xvfb and headless modes.
This proves the tested Docker path. The Chromium Container Acceptance CI job
validates Linux/amd64 when browser container inputs change. Native Linux host
service management and real-site login/anti-bot behavior need separate evidence.


For an explicit real-site observation, provide a public WeChat article and a local
artifact directory (Node 22+). This additionally visits `bot.sannysoft.com`, saves
viewport screenshots, records browser-reported fingerprint values and attempts to
read the article's `#js_content`. It does not solve challenges or change browser
fingerprint properties. Redirect query strings are omitted from evidence.

```sh
DISCLAUDE_CHROMIUM_ARTICLE_URL=https://mp.weixin.qq.com/s/ARTICLE_ID \
DISCLAUDE_CHROMIUM_EVIDENCE_DIR=/absolute/path/to/acceptance-evidence \
node scripts/test-chromium-container.mjs disclaude-chromium:060-test
```

A blocked or empty article returns exit 1 even when browser lifecycle assertions
pass (`lifecycleOk: true`, `articleRetrieved: false`). Fingerprints and the scanner
screenshot are observations requiring review; successfully retrieving an article
does not establish that every fingerprint requirement passed. The artifact
directory is retained intentionally; disposable containers and the profile volume
are cleaned up. No login or production profile is used.

On 2026-09-16 the existing image `13cfe36dc318` was tested on local Colima
Linux/aarch64, Chromium 151.0.7922.34. Its entrypoint, proxy configuration and
shutdown helper matched the repository files by SHA-256. The supplied target
article redirected to a WeChat environment challenge and returned zero article
characters. `navigator.webdriver` was boolean false (not undefined), languages
were `en-US`, timezone offset was -480, and WebGL had no context. The scanner
reported WebDriver checks passed but no WebGL context and an H.264 codec warning;
this was not an all-green fingerprint result. Screenshots confirmed the article
challenge. No fingerprint cause is inferred from this correlation.

Headed/headless CDP, DOM, screenshots, Cookie preservation after recreation and
proxy-failure shutdown passed. The first site attempt hit a screenshot timeout;
viewport capture with a dedicated timeout allowed observations to complete. This
is local evidence of the remaining #4800 gap, not acceptance on an unspecified
remote deployment machine, and does not close that issue.
