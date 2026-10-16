# Delivery dependency reuse and retention

Source checkouts use the pinned pnpm version and committed pnpm lockfile. Keep
each worktree's installation separate: workspace links resolve to that checkout.
Prebuilt releases keep the npm install contract and independent runtime prefixes.
Never copy or symlink an entire `node_modules` tree between those installations.

The checkout installation matrix now reuses one npm content-addressed download
cache across its independent Node/npm installations. Resolutions, optional native
packages and peer dependencies are still checked by each installation. The cache
and successful test prefixes are removed with the owned test root by default.
To reuse downloads across runs, explicitly select an external cache:

```sh
DISCLAUDE_INSTALL_TEST_NPM_CACHE="$HOME/.cache/disclaude-install-tests" \
  pnpm run test:install:checkout --matrix
```

That cache is not a runtime prefix. Do not set it to a worktree's `node_modules`.
Keep only the source identity, test report and required Node-version evidence for
completed delivery checks; retain a full prefix only for an active candidate,
rollback or an unresolved failure whose processes have not stopped. `--keep-temp`
is an explicit forensic exception, not the default delivery policy.

## Read-only retention preview

```sh
node scripts/delivery-retention.mjs --repo /path/to/disclaude \
  --delivery-root /path/to/disclaude/.local \
  --pin "$HOME/.disclaude/releases/previous-working-release" > retention.json
```

The command prints JSON and has no delete/apply mode. Defaults keep the two newest
delivery prefixes and releases, plus anything modified within seven days. `--pin`
is repeatable; pin every current deployment, rollback and retained failure source,
including service definitions that are not running. The parent of the release
directory is inspected for symlink selectors. Running command paths and open
executable/working directories add active PID references; observations are a local
user, point-in-time view. An incomplete scan prevents stale-prefix eligibility.

The report includes delivery `prefix*`/`sdk-prefix*` installs, release directories,
registered Git worktrees, npm's `_cacache` and individual `_npx` entries. It records
newest file modification age, logical directory sizes, allocated filesystem blocks,
unique inode allocation and exclusive allocation excluding hard links outside the
tree. Overlapping directory logical sizes are not additive; the global allocated
total deduplicates inodes. APFS clone extents, snapshots and compression are outside
this estimate, so it cannot promise the bytes a later deletion will release.

Only old, unreferenced prefixes/releases outside retention appear as
`review-stale-unreferenced`; this identifies review candidates, not permission to
delete them. User files can exist inside an old prefix. Worktrees and shared caches
always require owner review. Worktrees include dirty/untracked and ignored entry
counts, detached state, and upstream ahead/behind where available. Before manual
cleanup, inspect ownership, user data, runtime config, unpublished commits, open
files, service definitions and rollback requirements again. Use `git worktree
remove` for approved clean inactive worktrees and then `git worktree prune`; never
use `--force` to conceal uncertain content. This preview does not remove caches,
worktrees, releases or user data.
