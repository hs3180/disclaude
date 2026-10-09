# Docker Chromium CDP endpoint

This page documents the operator-side endpoint for the existing
`disclaude-chromium` Compose service. It is not an Agent configuration
interface. For the Agent call path and its single-call lock, see
[browser control](browser-coordination.md).

> The Compose commands here require a full source checkout. Prebuilt release
> packages omit Compose files; see the
> [Docker Compose deployment guide](docker-compose-deployment.md).

## Endpoint

Start the optional Chromium service with:

```sh
docker compose --profile chromium up -d chromium
```

The service publishes CDP on host loopback only. Disclaude in the same Compose
network uses `http://disclaude-chromium:${CDP_PORT:-9222}`. The host operator
endpoint is `http://127.0.0.1:${CDP_PORT:-9222}`. `GET /json/version` reports
browser metadata and the WebSocket debugger URL.

`CDP_PORT` selects the nginx-facing port (default `9222`);
`CDP_INTERNAL_PORT` selects Chromium's loopback listener (default `9221`) and
must differ from it. Nginx provides the WebSocket upgrade and the Host header
expected by Chromium. Compose publishes only `127.0.0.1:${CDP_PORT}`; do not
expose this unauthenticated control endpoint to an untrusted network.

## Disclaude integration

Disclaude uses the installed `chromium-cdp.json` configuration first.
`BU_CDP_URL` is a service-side fallback for an already deployed endpoint when
that configuration is absent; Docker Compose supplies the Chromium service URL
as this fallback. Invalid installed configuration fails explicitly rather than
silently selecting another endpoint.

The service's browser-use launcher passes the selected endpoint to the upstream
CLI process. It does not pass CDP settings to the Agent harness. Users do not
configure a browser socket or a separate coordinator service: one CLI invocation
is serialized against other invocations for that browser by a local OS file
lock. The browser/profile itself remains separately deployed and is not stopped
when Disclaude stops. There is no legacy service migration.

## Browser ownership and profile

The optional Compose service owns its `chromium_profile` volume. Do not start a
second Chromium process against that profile, and do not use `docker compose
down -v` if its browser state must be retained. Chromium runs with
`--no-sandbox` in the container; this is not a security boundary for untrusted
Agent code. See [Chromium in Docker](chromium-container.md) for profile
retention, assisted page verification, and shutdown behavior.

The Compose service and proxy are defined in `docker-compose.yml` and
`docker/chromium-cdp-nginx.conf`.
