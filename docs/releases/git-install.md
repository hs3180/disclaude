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
`release-candidates/...` branch to the same GitHub repository. Record its full SHA and `release-source.json` fingerprint in release notes or the
release review. Candidate identities are not committed as test fixtures.
Do not create or move a formal version tag during development.

```sh
node scripts/test-package-install.mjs github:hs3180/disclaude#FULL_40_CHARACTER_SHA
```

The smoke test uses a new prefix/cache and non-repository cwd, production-only
dependencies, explicit placeholder configuration, the unified CLI, all
runtime module imports, builtins discovery and offline DisclaudeService start/stop.
It does not call models or send messages. Successful temporary installations are
deleted; failures are retained for diagnosis. `--prefix-from-env` additionally
tests ordinary `npm install -g` with the destination configured via environment
instead of a command-line prefix (without touching the user's installation).

CI `npm test` generates a distribution from the current checkout, packs it into a
temporary archive and exercises installation on Node 20/22 × npm 10/11. It needs
no candidate branch, committed SHA or repository write permission. Locally opt in
with `DISCLAUDE_TEST_PACKAGE_INSTALL=1 npm test -- tests/git-release-install.test.ts`.
This verifies packaging and installed runtime behavior; actual remote Git/tag
installation remains an explicit release check using the command above.
The additional cross-platform workflow template requires maintainer installation;
do not count it as run until enabled.

## Final release

Require Linux/macOS, Node 20/22 and npm 10/11 evidence and all required CI before
the release decision. After explicit release approval, tag the tested distribution
commit as `v0.5.1`, then recheck the exact public command:

```sh
npm install -g "github:hs3180/disclaude#v0.5.1"
disclaude --version
disclaude start --help
disclaude channel --help
disclaude --help
```

For isolated verification without replacing the operator's installation, use
`node scripts/test-package-install.mjs github:hs3180/disclaude#v0.5.1 EXPECTED_SOURCE_FINGERPRINT --prefix-from-env`.
This checks CLI startup, HTTP status, graceful shutdown/restart, and package
provenance, not merely npm's exit status. Resolve the remote tag to the reviewed
distribution commit before running it; never silently retarget a published tag.

Only then declare the release complete. Keep the source SHA in release notes.
An optional `.tgz` must be packed from the same tested distribution; do not replace
tag acceptance with an archive test. Do not rewrite a published tag.
