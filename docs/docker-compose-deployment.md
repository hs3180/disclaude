# Docker Compose deployment

Docker Compose is supported from a full source checkout. The generated Git
release tag and the package installed by npm from that tag are prebuilt
distributions; they intentionally omit `docker-compose.yml`,
`Dockerfile.service`, and the source build inputs. Run Compose from the source
tree, not from an installed package directory.

To deploy the source revision used to build an installed release, read its
`sourceCommit` from `release-source.json`, then check out that commit in a full
repository clone:

```sh
PACKAGE_ROOT="$(npm root -g)/disclaude"
SOURCE_COMMIT="$(node -p 'require(process.argv[1]).sourceCommit' "$PACKAGE_ROOT/release-source.json")"
git clone https://github.com/hs3180/disclaude.git disclaude-source
git -C disclaude-source checkout "$SOURCE_COMMIT"
cd disclaude-source
cp disclaude.config.example.yaml disclaude.config.yaml
```

Edit `disclaude.config.yaml` for the deployment, then build and start the
service from that source checkout:

```sh
docker compose up -d --build
```

## Harness backends baked at build time (#5168)

Which agent harness backends the image pre-installs is a build-time
declaration (`DISCLAUDE_BACKENDS` build arg, default `all`); the container
never installs anything at startup. Set it in `.env` or via
`docker compose build --build-arg DISCLAUDE_BACKENDS=...`:

```sh
# .env — 'all' (default) or a comma-separated subset; unknown names fail the build
DISCLAUDE_BACKENDS=codex,dsh
```

| Backend (build arg) | `agent.agentBackend` / `backend` | Installed at build time | Version arg (pinned default) |
| --- | --- | --- | --- |
| `claude` | `claude` | nothing extra — the version-pinned `@anthropic-ai/claude-agent-sdk` ships via `pnpm-lock.yaml` | lockfile |
| `pi` | `pi` | `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` into `/app/node_modules` (production module resolution; `--no-save`, no lockfile change) | `PI_VERSION` (0.83.0) |
| `codex` | `codex` | `@openai/codex` CLI globally (on `PATH`) | `CODEX_VERSION` (0.154.0) |
| `dsh` (alias `deepseek`) | `dsh` | `@deepseek-ai/dsh` CLI globally (on `PATH`) | `DSH_VERSION` (0.1.2-rc.1) |

The backend's canonical name is `dsh` (matching the runtime config); the
build arg also accepts the alias `deepseek`. The pinned defaults in
`Dockerfile.service`, `docker-compose.yml` and
`docker/install-backends.mjs` are kept in sync by
`tests/docker-backends.test.ts`. Override a pin only with an exact version —
floating tags make builds unreproducible. Do not pass secrets as build args:
ARG values persist in the image history, and none are needed for backend
selection.

The image records the resolved selection in `/app/.backends-manifest.json`.
Startup prints one diagnostic line about backend availability, and the
in-container acceptance command re-checks every selected backend:

```sh
docker compose exec service node /app/scripts/install-backends.mjs --verify
```

See [GitHub installation guide](releases/git-install.md) for package
installation and the root `docker-compose.yml` for the source deployment
definition.
