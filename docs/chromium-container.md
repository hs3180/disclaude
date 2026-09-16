# Chromium in Docker

Build and start the optional browser service:

```sh
docker compose --profile chromium build chromium
docker compose --profile chromium up -d chromium
```

The browser image preinstalls nginx, Xvfb and network/readiness utilities, so
starting an already built image does not run apt or require package mirrors.
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
`CHROMIUM_LANG=C.UTF-8`. Override these for the deployment environment. Chromium
still runs as root with `--no-sandbox` inside this image, matching the prior
container boundary; it is not a sandbox for untrusted agent code. No guarantee
of third-party anti-bot acceptance, GPU renderer, or site login persistence is
made by enabling headed mode.

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
