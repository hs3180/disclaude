# Configured Jupyter candidate deployment

This is the concrete activation plan for the `configured-20261003` experimental
profile. It has not been executed. No package, server setting or existing
Notebook/kernel was changed during inspection or unit checks.

## Inspected target and staged changes

The host comes from the user's `JUPYTERLAB_HOST`; authentication stays in the
host-only `JUPYTERLAB_PASS` resolver. The inspected server runs in Docker with
Python 3.13.13 under `/opt/conda` and cwd `/build`. Its host Compose/deployment
directory and restart/rollback command still need to be identified. The current
instance has nine pre-existing kernels and no `/api/disclaude` coordinator.

The candidate adds one optional `disclaude-jupyter` wheel, a private persistent
SQLite ledger directory, and the following configuration to the existing server:

```python
c.ServerApp.jpserver_extensions.update({
    'jupyter_server_nbmodel': False,
    'disclaude_jupyter': True,
})
c.YDocExtension.server_side_execution = True
c.NotebookExtension.stack_profile = 'configured-20261003'
c.NotebookExtension.allow_experimental_stack = True
c.NotebookExtension.ledger_path = '/persistent/private/disclaude/notebooks.sqlite3'
c.NotebookExtension.idle_seconds = 60
c.NotebookExtension.max_rooms = 16
```

`/persistent/private` is a deployment placeholder, not a path to create blindly.
Select a persistent writable mount and private owner permissions after reading
the actual deployment. The existing Lab, RTC and file-ID extensions remain
enabled; verify their settings before activation. Do not replace the user's
whole configuration or authentication settings.

## Activation window

1. Record the actual image, launch command, mounted configuration and persistent
   data paths. Save the current configuration and package inventory privately.
2. Confirm that the user has finished or saved work in the nine existing kernels
   and explicitly authorized a Jupyter restart window. Saving a Notebook does
   not preserve Python variables, active jobs or kernel memory.
3. Stage a wheel from the reviewed commit. Verify its SHA-256 and exact runtime
   profile against the running server; install with `--no-deps`. No Jupyter
   package upgrade is part of this plan. In an immutable image, add the wheel to
   a derivative of the exact current image rather than installing it ephemerally.
4. Add the candidate settings, then restart only through the identified deployment
   controller. Do not launch a competing server or use a new local test instance.
5. Check password login, ordinary Lab/Contents readiness and authenticated
   `/api/disclaude`. Confirm protocol, exact stack, experimental profile, stable
   namespace and one ledger writer before binding a scratch acceptance Notebook.
6. On the same configured server/Notebook, verify DSH read/edit/run, manual
   Markdown/parameter edits, human Run and explicit handoff, persisted-session
   continuation, real Feishu `/stop`, same-kernel continuation and accessible
   report/chart delivery. Record unknown outcomes and never replay them.

Stock Lab kernel interrupt/input integration, HTML report sandboxing, large
artifacts and the complete recovery matrix still have implementation/acceptance
gaps. Activating this candidate does not close those release conditions.

## Rollback

If startup or readiness fails, restore the saved extension configuration and
original image/package state through the same deployment controller, then verify
ordinary authenticated Lab and service health. Preserve the candidate ledger and
test Notebook as evidence; do not reset state or claim interrupted kernel memory
was restored. Never send a candidate run when its namespace, generation or kernel
incarnation is uncertain. Daily disclaude remains on its original healthy service
until a separate authorized candidate acceptance window is prepared.
