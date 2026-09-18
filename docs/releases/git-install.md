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

The dedicated Package Installation Acceptance CI job generates a distribution
from the committed checkout, packs a temporary archive, and exercises installation
on Node 20/22 × npm 10/11 through external processes. It needs no candidate branch
or repository write permission. After `npm run build`, run
`npm run test:install:checkout` locally, or add `-- --matrix` for the runtime matrix.
Unit tests and coverage no longer install packages or run this acceptance matrix.
The job uploads its log with a final `PACKAGE_ACCEPTANCE_REPORT` recording source
provenance, passed checks, overall status and cleanup status. The owned-process
runner controls process-group cleanup; interrupted child processes do not cause
the archive directory to be deleted while it may still be in use.
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

### Installation-test temporary files

`test-package-install.mjs` removes its complete isolated test directory on success
and ordinary assertion failures, including npm cache, installed package, config
and generated workspace files. It reports `PACKAGE_TEST_CLEANUP_OK` after removal.
Use `--keep-temp` explicitly when you need to inspect the generated files; the
script prints the retained directory. Remove that exact directory after diagnosis
and after confirming its test processes have stopped.

A command timeout or unconfirmed CLI shutdown retains the directory with a
diagnostic instead of deleting files that a process may still use. Signal handling
and recovery after forced termination are not yet covered by this script's
`finally` cleanup; these remain tracked in #5049. Do not use broad temporary-path
globs to clean concurrent test runs or user workspaces.


The Node/npm matrix helper `scripts/test-git-node22.mjs` also removes its isolated
Node/npm tooling and download cache on success or ordinary assertion failure.
It reports `MATRIX_TOOLING_CLEANUP_OK`; `--keep-temp` explicitly retains that
helper directory. If a subprocess is signaled, times out, exceeds the captured-output bound,
or an inner package test reports retained files, it reports `MATRIX_TOOLING_RETAINED` instead because termination is unconfirmed.
Inspect the reported directory and process state before manual cleanup. This does
not add signal/forced-termination recovery, and nested installation tests retain
their own cleanup diagnostics.

Upgrade and rollback checks use the existing shell/CI installation workflow;
experimental reports and one-off runners remain outside the repository.


## Foreground test ownership and recovery

`npm run test:install -- /absolute/path/package.tgz` now runs the installer under
`scripts/run-isolated-test.mjs`. Use the same wrapper for the foreground Node/npm
matrix and upgrade/rollback helpers:

```sh
node scripts/run-isolated-test.mjs -- node scripts/test-git-node22.mjs /absolute/path/package.tgz
npm run test:install:checkout -- --matrix
```

On macOS/Linux the wrapper supplies a private per-run TMPDIR/TMP/TEMP and starts
a separate process group. Before releasing the test, it records owner PID, group
ID and directory identity in a mode-0700 registry under the invoking TMPDIR.
SIGINT/SIGTERM requests group shutdown and waits at most 15 seconds before retaining
live files with a diagnostic. Successful and ordinary failed runs remove their roots
only after that group is absent. It never modifies the user's HOME or production
workspace and never upgrades global Node/npm.

The next invocation in the same TMPDIR reaps only registered roots whose owner
and process group are both absent. It does not signal orphan groups, delete by age,
or scan legacy temporary directory prefixes. Live peers, uncertain ownership and
explicit `--keep-temp` are retained. PID reuse may conservatively delay cleanup.
For explicit retention, inspect the printed root and confirm its recorded processes
have stopped before removing it manually. An incomplete initialization marker is
reported for manual inspection, not treated as safe to delete.

This wrapper is for foreground-only tests. It must not wrap tests that install
launchd/systemd services, create Docker resources, or detach their own process
session. Those require resource-specific ownership/teardown. Changing TMPDIR does
not discover the old registry, and SIGKILL does not promise to stop a running test;
it leaves a diagnosable group that must finish before reaping. Therefore #5049 is
still open for the remaining suites/resources. Containers need a functioning init
(e.g. Docker `--init`) to reap orphan/zombie processes; an unreaped group is retained
rather than treated as absent. The CI process test uses real
signals and foreground fixtures; it does not stand in for package-release acceptance.
