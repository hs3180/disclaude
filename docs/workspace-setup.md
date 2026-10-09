# Workspace setup and migration

On the first terminal `disclaude start` without a workspace setting, the terminal
wizard suggests `~/disclaude-workspace`. It shows the full path, explains that
this directory stores task files, downloads and results, accepts a custom path,
and asks for confirmation. Invalid paths can be corrected. Cancelling does not
save a workspace setting. The selected directory is created and its absolute
path saved in `~/.disclaude/disclaude.config.yaml` (or the selected config).

This is workspace setup, not backend/channel credential setup. With no config,
a minimal workspace configuration is created; configure your backend and channel
before starting the service. Existing explicit workspace settings and
`DISCLAUDE_WORKSPACE_DIR` remain authoritative, including in unattended startup.
Unattended startup without either setting fails with setup instructions.
Existing explicitly configured paths are not automatically created: a missing
mount or misspelled production directory must still fail startup.

Copying the example config leaves workspace selection to the wizard. For a
service or container, create the intended directory and set an absolute
`workspace.dir` first. Docker normally uses `/data/workspace`.

## Moving an existing production workspace

No automatic migration occurs during upgrade or first-run setup. Treat the
workspace as user data, including hidden files, histories, schedules, local Git
repositories, permissions, secrets and symlinks.

1. Inventory the effective configuration, environment overrides, service
   definition, absolute path references and processes writing the workspace.
   Prepare a private backup of the config/service definition and a rollback plan.
2. Prepare the destination outside the source repository. Use a metadata-preserving
   copy; APFS clones may reduce temporary disk requirements but are not independent
   backups. Keep the original data until migration is verified.
3. Stop the service and quiesce other writers for the final synchronization.
   Do not run old and new bot connections simultaneously. Verify file hashes,
   symlink targets, permissions and counts while the source is stable.
4. Update the config's workspace path, any workspace-rooted configuration paths,
   and the service's working directory/config argument. Review schedule scripts
   and absolute references. A compatibility symlink can preserve old absolute
   paths, but must never mask an unsuccessful copy or overwrite an existing path.
5. Start the same supported installed release with the new config. Verify health,
   the effective workspace, scheduler/history availability and a bounded local
   file write. Keep the source snapshot and record any post-cutover writes.
6. On failure, stop the new process before restoring the old service definition.
   Reconcile new writes before switching workspace data back; blindly replacing
   the destination with the old snapshot would lose changes.

A directory-size total does not establish free disk requirements or reclaimable
space on APFS. Compare actual free space and validate the copied content.
