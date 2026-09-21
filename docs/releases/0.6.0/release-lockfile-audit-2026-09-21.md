# 0.6.0 release lockfile audit

Date: 2026-09-21

Baseline: `origin/main` at `1e4c1442` (`fix(browser): disable Chromium automation exposure (#5134)`).

## Finding

The source tree no longer contains `packages/worker-node`, and the root workspace remains the glob `packages/*`. The lockfile nevertheless contains this workspace entry:

```json
"packages/worker-node": {
  "name": "@disclaude/worker-node",
  "version": "0.0.4",
  "extraneous": true
}
```

The entry also retains the removed `disclaude-worker` bin and worker-only dependencies. `packages/primary-node` is absent from both the source tree and the lockfile, so this is a distinct stale-runtime residue.

## Reproduction

```sh
test ! -e packages/worker-node
node -e "const p=require('./package-lock.json'); console.log(p.packages['packages/worker-node'])"
npm ci --ignore-scripts --no-audit --no-fund
npm ls @disclaude/worker-node --all --json
```

Observed on the baseline:

- `packages/worker-node` does not exist;
- the lockfile entry is present and marked `extraneous: true`;
- `npm ci` succeeds and installs 572 packages, so the stale lockfile node is not caught by the current install smoke;
- `npm ls @disclaude/worker-node` reports only the root package, while the lockfile still advertises the removed workspace.

## Boundary

This PR is discovery only. It does not edit the lockfile, package manifests, Docker files, or tests. The follow-up fix must be independently based on `main`, remove only the stale lockfile workspace node, and add a release-contract assertion so a later package-manager operation cannot silently reintroduce it. Historical migration documentation may mention the old runtime, but generated/package metadata for the current candidate must not.
