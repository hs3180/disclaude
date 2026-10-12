# Chromium in Docker

Build and start the optional browser service:

> These Compose commands require a full source checkout. Prebuilt release
> packages omit Compose files; see the
> [Docker Compose deployment guide](docker-compose-deployment.md).

```sh
docker compose --profile chromium build chromium
docker compose --profile chromium up -d chromium
```

The image includes nginx, Xvfb, password-protected noVNC, and readiness
utilities. `CHROMIUM_IMAGE_TAG` selects the official Playwright browser image
used as its base. This starts Chromium; it does not install or select a
Playwright agent.

By default, Chromium runs with Xvfb at 1920×1080. Set `CHROMIUM_HEADLESS=1` for
headless mode; VNC/noVNC is then skipped with an info log, even when
`CHROMIUM_VNC_ENABLED=1`. The process supervisor stops Chromium, the proxy and display
together if any exits. Compose publishes the CDP endpoint on loopback only; see
the [service-internal CDP contract](cdp-endpoint.md).

The `chromium_profile` volume is mounted at `CHROMIUM_CDP_PROFILE_DIR`, which
defaults to `/data/chrome-profile`; Chromium receives the same path as its
`--user-data-dir`. Set an absolute container path in the Compose `.env` file to
change it. Restarts and container recreation preserve the volume at that path.
Do not use `docker compose down -v` when retaining browser state. The profile
belongs to the container browser and is not the host's daily Chrome profile.
Changing the configured path selects a different profile; setup does not copy or
migrate profile contents.

Defaults include `CHROMIUM_MEMORY=4G`, `CHROMIUM_SHM_SIZE=2gb`,
`TZ=Asia/Shanghai`, `CHROMIUM_LANG=C.UTF-8`, and
`CHROMIUM_ACCEPT_LANG=en-US,en`. `CHROMIUM_LANG` sets the process locale;
`CHROMIUM_ACCEPT_LANG` controls Chromium's Accept-Language and JavaScript
language properties. Set a comma-separated value such as `zh-CN,zh` for a
Chinese-language deployment. This startup setting does not rewrite profile
preferences.

Chromium runs as root with `--no-sandbox` inside this image. The container is
not a sandbox for untrusted agent code. Headed mode does not guarantee
third-party anti-bot acceptance, a GPU renderer, or site login persistence.

## Human-assisted page verification

The normal Compose command above enables VNC/noVNC for the headed browser;
no `.env` or overlay is required. Port 6080 is published on `0.0.0.0` so the
same browser is visible from the LAN. The CDP port stays on `127.0.0.1`.

When `CHROMIUM_VNC_PASSWORD` is empty, startup generates an eight-character
random password and prints `INFO: generated VNC password: ...` in the container
log. Read it with `docker compose logs chromium`. A new password is generated
on each start; the persistent browser profile is retained. Authentication is
required. An explicit password must be exactly eight printable, non-space
ASCII characters and is not printed. For a fixed password or loopback-only view:

```sh
export CHROMIUM_VNC_PASSWORD='Ab3!xY7?'
export CHROMIUM_VNC_BIND=127.0.0.1
export CHROMIUM_VNC_HOST_PORT=6080
docker compose --profile chromium up -d chromium
```

Open this URL from the same LAN, replacing `<browser-host>` with the Docker host:

```text
http://<browser-host>:6080/vnc.html?autoconnect=true&resize=scale&reconnect=true
```

Enter the password when noVNC asks for it. Navigate the existing browser to the
target site and complete only visible human verification. Do not automate
CAPTCHA input, record the password, or publish the CDP port. On macOS
Docker/Colima, the default `0.0.0.0` bind works when the backend rejects a
specific host-interface address.

Set `CHROMIUM_VNC_ENABLED=0` to disable the headed VNC/noVNC processes.
Headless mode always skips them. The former `docker-compose.chromium-vnc.yml`
overlay remains compatible with existing operator commands and is optional.
Stop the browser cleanly so Chromium can flush its profile:

```sh
docker compose --profile chromium stop chromium
```

The `chromium_profile` volume is retained. It has one owner: do not start a
second Chromium against the active profile. A completed verification is an
assisted bootstrap, not an automatic challenge bypass; a site may challenge the
profile again after expiry or a network/context change.

On normal shutdown, the supervisor requests `Browser.close` over Chromium's
internal loopback CDP connection and allows 15 seconds for the browser to flush
state. If CDP is unresponsive, bounded process termination is the fallback and
cannot guarantee pending writes were committed.
