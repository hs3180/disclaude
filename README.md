# Disclaude

[![GitHub release](https://img.shields.io/github/v/release/hs3180/disclaude)](https://github.com/hs3180/disclaude/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)

Disclaude connects Feishu/Lark, personal WeChat (Tencent iLink), and REST
conversations to agent harnesses for
software development and research. It supports ongoing conversations,
scheduled work, project-scoped skills, and coordinated browser automation.

**Release target: [v0.6.7](https://github.com/hs3180/disclaude/releases/tag/v0.6.7).**
Check the [latest published release](https://github.com/hs3180/disclaude/releases/latest).
See the [release notes](docs/releases/0.6.7.md)
and [changelog](CHANGELOG.md). Published release tags are immutable; follow-up
changes ship under a new version.

## Capabilities

- **Agentic Research:** continue from an existing Feishu Project, investigate
  evidence, deliver a readable report, and keep detailed sources in the Project.
- **Agent harnesses:** Claude, Codex, Pi, and DeepSeek, selected through named
  configuration presets.
- **Feishu interaction:** streaming replies, interactive cards for Codex input,
  files, and chat-based follow-up.
- **Personal WeChat:** QR login, saved sessions, encrypted image/file transfer,
  native MP4 delivery, public progress messages, and registered-account management.
- **Browser automation:** a service-provided launcher serializes complete
  upstream `browser-use` CLI calls per CDP browser; no separate Disclaude broker
  is required.
- **Operations:** scheduled tasks, workspace-backed files, service diagnostics,
  and source-checkout Docker Compose or macOS deployment.

## Documentation

| Guide | Purpose |
| --- | --- |
| [Feishu channel](docs/feishu-channel.md) | App setup, supported interactions, and cards |
| [Personal WeChat](docs/wechat-channel.md) | QR login, account management, media, and channel coexistence |
| [Workspace setup](docs/workspace-setup.md) | Choose or safely move persistent project data |
| [Environment variables](docs/environment-variables.md) | Operator-facing runtime settings |
| [Codex](docs/codex-backend.md), [Pi](docs/pi-backend.md), [DSH](docs/dsh-backend.md) | Backend-specific configuration |
| [Browser control](docs/browser-coordination.md) | Serialized CLI calls, ownership, and recovery |
| [Jupyter repair CLI](jupyter/datalayer/README.md#cli-deployment) | Generate/deploy the upstream repair and inspect restart requirements |
| [Skills](docs/skills.md) | Discovery, precedence, and CLI contract |
| [Logging](docs/logging.md) | File output, rotation, and collection |
| [GitHub installation](docs/releases/git-install.md) | Install, upgrade, and roll back a release tag |
| [Docker Compose deployment](docs/docker-compose-deployment.md) | Deploy from the full source checkout |

## Quickstart

Requirements: Node.js 20 or later, npm 10 or later, and Git. Create and publish
a Feishu/Lark app with a bot, required permissions, and a persistent event
connection as described in the [Feishu channel guide](docs/feishu-channel.md).

Install the release tag below after it is published, then create a configuration file:

```sh
npm install -g "github:hs3180/disclaude#v0.6.7"
mkdir -p ~/.disclaude
cp "$(npm root -g)/disclaude/disclaude.config.example.yaml" \
  ~/.disclaude/disclaude.config.yaml
```

Edit the config with the app credentials and a supported backend, then start
the service:

```sh
disclaude start
```

Add the bot to a chat and send `@bot 你好` to verify it responds. See the
[Feishu channel guide](docs/feishu-channel.md) for permissions, event
subscriptions, cards, and interactive input details.
The prebuilt distribution is installed from GitHub tags; the source package is
not published to the npm registry. Preserve your configuration and workspace
when upgrading. Use the [installation guide](docs/releases/git-install.md) for
upgrade and rollback instructions.

For personal WeChat, follow the [WeChat guide](docs/wechat-channel.md) for QR
login and channel configuration instead of Feishu app setup.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm test
```

Contributions should include focused tests and documentation updates for any
user-visible behavior change.

## License

MIT

See [worktree dependencies](docs/worktree-dependencies.md) for shared-store setup and safe cleanup.
