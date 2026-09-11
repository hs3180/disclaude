# Prebuilt GitHub tag distribution

Issue #4922 is a 0.5.1 release gate. A successful `.tgz` install does not satisfy it.

## Structure

Development stays on main with workspaces and explicit `npm run hooks:install`.
Release tags point to separate generated distribution commits. Their
`release-source.json` records the source SHA and a fingerprint of runtime source,
manifests, build settings, generator and shipped resources. Never merge a generated
distribution branch into main.

The generator copies compiled modules, rewrites internal workspace imports to
relative imports, and creates a root manifest containing external runtime
dependencies only. There are no workspace manifests, build/prepare/install hooks,
development dependencies or symlinks to the build machine. Tracked shared
resources and CLI wrappers are included; local configuration and node_modules are not.

## Candidate preparation

Use a fresh checkout with committed changes and no concurrent test process:

```sh
npm ci --include=dev
npm run build
node scripts/build-git-release.mjs /absolute/path/to/new-empty-distribution
```

Initialize the output as a separate Git repository and push a uniquely named
`release-candidates/...` branch to the same GitHub repository. Record its full SHA
and `release-source.json` fingerprint in `tests/fixtures/git-release-candidate.json`.
Do not create or move a formal version tag during development.

```sh
node scripts/verify-git-candidate.mjs
node scripts/test-package-install.mjs github:hs3180/disclaude#FULL_40_CHARACTER_SHA
```

The smoke test uses a new prefix/cache and non-repository cwd, production-only
dependencies, explicit placeholder configuration, both CLI executables, all
runtime module imports, builtins discovery and offline PrimaryNode start/stop.
It does not call models or send messages. Successful temporary installations are
deleted; failures are retained for diagnosis. `--prefix-from-env` additionally
tests ordinary `npm install -g` with the destination configured via environment
instead of a command-line prefix (without touching the user's installation).

The existing CI `npm test` runs the remote SHA installation gate on GitHub Actions
using the runner's Node 20/npm 10 and isolated Node 22.23.2/npm 11.6.0 tooling.
Locally opt in with `DISCLAUDE_TEST_GIT_INSTALL=1 npx vitest run tests/git-release-install.test.ts`.
Source fingerprint verification runs even without the network gate. Runtime
changes require regenerating the candidate; a passing stale candidate is rejected.
The additional cross-platform workflow template requires maintainer installation
if the submitting App still lacks workflows permission; do not count it as run.

## Final release

Require Linux/macOS, Node 20/22 and npm 10/11 evidence and all required CI before
the release decision. After explicit release approval, tag the tested distribution
commit as `v0.5.1`, then recheck the exact public command:

```sh
npm install -g "github:hs3180/disclaude#v0.5.1"
disclaude --version
disclaude start --help
disclaude channel --help
disclaude-primary --help
```

Only then declare the release complete. Keep the source SHA in release notes.
An optional `.tgz` must be packed from the same tested distribution; do not replace
tag acceptance with an archive test. Do not rewrite a published tag.
