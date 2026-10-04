# Install and upgrade from a GitHub release tag

Disclaude's prebuilt distribution is published as a versioned GitHub tag, not
to the npm registry. Use a release tag rather than `main` for an installed
service.

## Requirements

- Node.js 20 or later
- npm 10 or later
- Git available to npm

## Install or upgrade

Choose the exact release tag to install. For v0.6.2:

```sh
npm install -g "github:hs3180/disclaude#v0.6.2"
disclaude --version
disclaude start --help
```

For a new installation, copy the example configuration from the installed
package and edit it before starting the service:

```sh
mkdir -p ~/.disclaude
cp "$(npm root -g)/disclaude/disclaude.config.example.yaml" \
  ~/.disclaude/disclaude.config.yaml
```

Set up the backend, channel, and workspace in the configuration. See the
[Feishu channel guide](../feishu-channel.md),
[workspace guide](../workspace-setup.md), and the
[root README quickstart](../../README.md#quickstart).

When upgrading an existing deployment:

1. Back up the configuration, workspace, and service definition. The workspace
   contains user data and is not part of the package installation.
2. Stop the existing service using its current service manager. Avoid running
   two bot connections against the same channel.
3. Install the selected release tag and verify the installed version and CLI
   help as above.
4. Start the service using the same deployment method and confirm its health,
   channel connection, workspace, and scheduled tasks.

Package installation does not migrate or delete configuration or workspace
data. For workspace relocation, use the separate
[workspace migration procedure](../workspace-setup.md#moving-an-existing-production-workspace).

## Docker Compose deployment

The generated release tag is a prebuilt distribution. It intentionally omits
the source Docker build files, so it does not include a Compose deployment
entry point. To use Docker Compose, follow the
[source deployment guide](../docker-compose-deployment.md) with a full source
checkout. The guide also shows how to check out the exact source commit recorded
in `release-source.json` for this release.

## Roll back

If the new version does not start or pass health checks, stop it and reinstall
the previously working release tag:

```sh
npm install -g "github:hs3180/disclaude#PREVIOUS_TAG"
disclaude --version
```

Restart using the existing service manager and verify the service against the
preserved configuration and workspace. Do not remove workspace data or start
the old and new services concurrently. Keep the previous tag and configuration
backup until the rollback is verified.
