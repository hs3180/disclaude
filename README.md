# Disclaude

[![GitHub release](https://img.shields.io/github/v/release/hs3180/disclaude)](https://github.com/hs3180/disclaude/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)

Disclaude connects Feishu/Lark and REST conversations to agent harnesses for
software development and research. It supports ongoing conversations,
scheduled work, project-scoped skills, and coordinated browser automation.

**Latest release: [v0.6.0](https://github.com/hs3180/disclaude/releases/tag/v0.6.0).**
See the [release notes](docs/releases/0.6.0.md) and [changelog](CHANGELOG.md).

## Capabilities

- **Agentic Research:** continue from an existing Feishu Project, investigate
  evidence, deliver a readable report, and keep detailed sources in the Project.
- **Agent harnesses:** Claude, Codex, Pi, and DeepSeek, selected through named
  configuration presets.
- **Feishu interaction:** streaming replies, interactive cards for Codex input,
  files, and chat-based follow-up.
- **Browser automation:** agents and users coordinate access to a shared browser
  through the service-owned browser coordinator.
- **Operations:** scheduled tasks, workspace-backed files, service diagnostics,
  and Docker or macOS deployment.

## Documentation

| Guide | Purpose |
| --- | --- |
| [Quickstart](docs/quickstart.md) | Build and run a Feishu-connected service |
| [Feishu setup](docs/feishu-setup.md) | Create the app, permissions, and event subscription |
| [Workspace setup](docs/workspace-setup.md) | Choose or safely move persistent project data |
| [Environment variables](docs/environment-variables.md) | Operator-facing runtime settings |
| [Codex](docs/codex-backend.md), [Pi](docs/pi-backend.md), [DeepSeek](docs/dsh-backend.md) | Backend-specific configuration |
| [Browser coordination](docs/browser-coordination.md) | Agent access and coordinator lifecycle |
| [GitHub installation](docs/releases/git-install.md) | Install, upgrade, and roll back a release tag |
| [Documentation index](docs/README.md) | Current design contracts and operator guides |

## Install v0.6.0

Requirements: Node.js 20 or later, npm 10 or later, and Git.

```sh
npm install -g "github:hs3180/disclaude#v0.6.0"
mkdir -p ~/.disclaude
cp "$(npm root -g)/disclaude/disclaude.config.example.yaml" \
  ~/.disclaude/disclaude.config.yaml
```

Edit `~/.disclaude/disclaude.config.yaml` with your Feishu credentials and a
supported backend, then start the service:

```sh
disclaude start
```

See the [quickstart](docs/quickstart.md) for configuration and Feishu setup.
The prebuilt distribution is installed from GitHub tags; the source package is
not published to the npm registry. Preserve your configuration and workspace
when upgrading. Use the [installation guide](docs/releases/git-install.md) for
upgrade and rollback instructions.

## Development

```sh
npm ci --include=dev
npm run build
npm test
```

Contributions should include focused tests and documentation updates for any
user-visible behavior change.

## License

MIT
