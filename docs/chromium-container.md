# Chromium in Docker

Build and start the optional browser service:

```sh
docker compose --profile chromium build chromium
docker compose --profile chromium up -d chromium
```

The image includes nginx, Xvfb, optional noVNC components, and readiness
utilities. `CHROMIUM_IMAGE_TAG` selects the official Playwright browser image
used as its base. This starts Chromium; it does not install or select a
Playwright agent.

By default, Chromium runs with Xvfb at 1920×1080. Set `CHROMIUM_HEADLESS=1` for
headless mode. The process supervisor stops Chromium, the proxy and display
together if any exits. Compose publishes the CDP endpoint on loopback only; see
the [service-internal CDP contract](cdp-endpoint.md).

The dedicated `chromium_profile` volume is mounted at `/data/chrome-profile`.
Restarts and container recreation preserve it. Do not use `docker compose down
-v` when retaining browser state. The profile belongs to the container browser
and is not the host's daily Chrome profile. An existing `/tmp/chrome-cdp` profile
is not automatically migrated; stop the old browser cleanly and back up its
profile before removing or recreating that container. A copied profile does not
guarantee that login cookies can be decrypted across browser applications.

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

For a site that presents a visible verification page, the tracked Compose
override can expose a temporary, password-protected noVNC view of the same
headed browser. The normal Compose file does not publish a VNC port.

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

Enter the password when noVNC asks for it. Navigate the existing browser to the
target site and complete only visible human verification. Do not automate
CAPTCHA input, record the password, or publish the CDP port. On macOS
Docker/Colima, publish the VNC port on `0.0.0.0` if the backend rejects a
specific host-interface address.

Stop the override cleanly so Chromium can flush its profile:

```sh
docker compose -f docker-compose.yml -f docker-compose.chromium-vnc.yml \
  --profile chromium stop chromium
```

The `chromium_profile` volume is retained. It has one owner: do not start a
second Chromium against the active profile. A completed verification is an
assisted bootstrap, not an automatic challenge bypass; a site may challenge the
profile again after expiry or a network/context change.

On normal shutdown, the supervisor requests `Browser.close` over Chromium's
internal loopback CDP connection and allows 15 seconds for the browser to flush
state. If CDP is unresponsive, bounded process termination is the fallback and
cannot guarantee pending writes were committed.
