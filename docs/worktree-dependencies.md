# Worktree dependencies

Source development uses **pnpm 10.33.0**, pinned in `package.json`, and one
`pnpm-lock.yaml` for the root and `packages/*`. Prebuilt release packages still
install with npm; their generated manifest contains no workspace dependencies
or development package-manager requirement.

Each Git worktree owns its `node_modules` and workspace links. pnpm shares
dependency file contents through a content-addressable store on the same
filesystem. `packageImportMethod: auto` uses copy-on-write clones on APFS and
hardlinks when cloning is unavailable. Deleting one worktree does not delete
the store or another worktree's dependencies.

## Install only when needed

From an existing checkout, inspect the registered worktrees before creating
an isolated branch:

```sh
git worktree list
git worktree add -b feature/example ../disclaude-example origin/main
cd ../disclaude-example
corepack enable
pnpm --version                  # 10.33.0, from packageManager
pnpm store path                 # normally ~/Library/pnpm/store/v10 on macOS
pnpm install --frozen-lockfile
pnpm run build
```

Reuse a task's existing worktree and installed dependencies when its lockfile
has not changed. Do not install for a documentation-only task. A warm store
can install without network access:

```sh
pnpm install --offline --frozen-lockfile
```

If Corepack is unavailable, install the exact pinned tool with
`npm install --global pnpm@10.33.0`. This installs tooling, not source
dependencies. CI reads the pin through `pnpm/action-setup`; Docker installs
the version from the manifest and caches `/pnpm/store`.

## Share the store, keep links local

The default store already shares files between worktrees on the same volume.
When a custom store is necessary, configure it once for the machine, choosing
a directory on the volume containing the worktrees:

```sh
pnpm config set --global store-dir "$HOME/Library/pnpm/store"
pnpm store path
```

Do not symlink, copy, or bind-mount another worktree's entire `node_modules`.
Do not set a common `virtualStoreDir`. Local `@disclaude/*` dependencies use
`workspace:*`, so they must resolve to the current checkout's `packages/`.
You can verify the link without starting the service:

```sh
node --input-type=module -e 'import fs from "node:fs"; console.log(fs.realpathSync("node_modules/@disclaude/core"))'
```

The repository disables the experimental global virtual store. It changes
hoisting behavior and can expose undeclared dependencies in ESM imports;
validate ESM resolution, builds, tests and packaging before experimenting
with it. See the [pnpm 10 settings](https://pnpm.io/10.x/settings).

For filesystems without copy-on-write cloning, `auto` falls back to hardlinks.
An explicit `--package-import-method=hardlink` also permits checking file inode
sharing on the same volume; treat installed dependencies as read-only and
reinstall instead of editing files in `node_modules`.

## Retire a worktree safely

Before removal, check local edits, branch/upstream divergence, detached
commits, ignored files, process working directories, open files and service
configuration references. Keep active services, local changes and user data.
Archive required evidence and logs outside the retiring directory; retain
its branch, or create a ref for a detached commit.

For a suspended worktree, remove only its regenerable dependencies and build
outputs after that audit. For a concluded, clean, idle worktree:

```sh
git worktree remove ../disclaude-example
git worktree prune
```

Do not use `--force` to bypass the audit. Store cleanup is separate:
`pnpm store prune` can remove cached versions needed for offline installation
of older branches, so do not run it as part of routine worktree removal.

Old branches keep their own committed npm lockfile until the complete pnpm
migration commit is merged or cherry-picked. Never replace only their
dependency directory or create a second lockfile in them.
