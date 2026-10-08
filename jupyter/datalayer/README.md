# Remote Datalayer repair candidate

This directory repairs the existing `jupyter_server_nbmodel` package and its
bundled Lab client. It does not install `disclaude_jupyter`, introduce another
execution endpoint or run Python on the disclaude host. It is a development
candidate until the configured-server, Lab and product checks pass.

The baseline is the user's installed nbmodel 0.2.9 / Lab bundle 0.2.8, with
MCP 2.2.3, collaboration 5.0.4, server-ydoc 3.0.4 and Lab 4.6.4. Each modified
file has an exact before/after SHA-256 in `manifest.json`; an unknown source
or existing repair module is refused. The upstream BSD notice is retained in
`LICENSE.nbmodel`. `frontend-source.patch` contains the corresponding upstream
TypeScript changes; `patches/lab-*.patch` applies them to the verified shipped
bundle. New bundle/loader names avoid reuse of cached original JavaScript.
Changed generated files omit the original source-map link.

For review, start with [why each patch is needed](PATCHES.md): the six observed
upgraded-server failures, their research impact, the Python/Lab file mapping,
required versus optional changes, evidence and limits. The scope is the pinned
installation above; newer upstream releases need their own verification.

## CLI deployment

The CLI installs the upstream Jupyter/nbmodel repair through **authenticated
Jupyter Terminal only**. The host generates the artifact with Node; the Terminal
runs it under the existing Jupyter Server Python 3.9+ environment. Python and
scientific packages remain managed by the Jupyter deployment owner.

```sh
# Default: the Jupyter endpoint and credentials from cwd/.env or environment
disclaude jupyter patch prepare
disclaude jupyter patch apply
disclaude jupyter patch status
# Restore the exact original files saved by prepare
disclaude jupyter patch rollback
```

`prepare` stages verified originals and candidate files without changing installed
package/config files. `apply` installs them on disk; `rollback` restores saved
original bytes, modes and owners and removes added files. Both return
`activation=server_restart_required`, `serverRestartRequired=true` and
`runningCodeVerified=false`. Save notebooks and close kernels, restart Jupyter
with its existing deployment manager, then refresh Lab to activate the changes.
This CLI does not stop, start or restart the Server.

The Server's already imported modules and queue objects continue using their
existing code until restart. New Lab bundle/loader names retain the original
static resources for existing pages. File installation does not preserve kernel
memory across the subsequent restart and does not establish product acceptance.
Do not restart during a failed/partial installation: inspect `status` and restore
the saved originals with `rollback` first.

### Authentication

Jupyter must enable POSIX Terminal REST and WebSocket access for this login.

```sh
# Select a private .env file; never prompt in automation
disclaude jupyter patch prepare --env-file /your/private/.env --no-interactive
# Select an endpoint and enter password or token without secret echo
disclaude jupyter patch apply --jupyter https://your-jupyter.example/ --interactive
# Re-enter authentication for the configured endpoint
disclaude jupyter patch status --interactive
```

The default `--jupyter configured` resolves `JUPYTERLAB_HOST` with
`JUPYTERLAB_PASS` (password) or `JUPYTERLAB_TOKEN` (API token).
A literal `--jupyter URL` selects the endpoint. The CLI reads `.env` only in
the current directory or the exact `--env-file`; values are parsed as data,
not shell-expanded, executed, copied to `process.env` or saved back.
All three input methods work on supported Node 18+ runtimes.

Actual environment variables override the same keys in `.env`, including empty
values; environment credentials are preferred across both authentication modes.
Password is preferred when both modes are present in the same source.
`--password-env NAME` / `--token-env NAME` explicitly select the mode and allow
custom keys.

An interactive terminal prompts for missing endpoint/authentication values.
`--interactive` requests fresh credentials even when configured; an explicit
authentication key skips the mode question. `--no-interactive` requires complete
configuration. Missing values without a TTY fail before connecting. Ctrl-C,
Ctrl-D and SIGTERM restore terminal input state. Prompts use stderr and secrets
are hidden, preserving JSON stdout. Failed authentication is not retried.

Credentials and cookies remain in host memory and never enter shell commands,
artifacts, installation state, output or persistent prompt history. The HTTP
client preserves cookie/XSRF/origin and redirect rules, including reverse-proxy
URL prefixes. Credentials must not be placed in CLI arguments or URL queries.

### Environment discovery and rollback state

The CLI creates and closes only its own Terminal. It transfers the generated
artifact with SHA-256 verification and bounded PTY input lines, then discovers
the Server interpreter from the Terminal's process ancestry.
Use `--python /your/env/bin/python` when discovery is ambiguous.

That interpreter determines the installed Python package. Jupyter's own
config/data search paths locate the Lab extension and standard shared config,
respecting `JUPYTER_CONFIG_PATH`, `JUPYTER_CONFIG_DIR`, `JUPYTER_PATH`,
the environment prefix and the login's permissions. There is no fixed Jupyter
installation directory. `--config-file /your/config.py` or `.json` selects a
custom startup config; `--frontend-dir /your/labextension` resolves ambiguous
Lab installations. Run as the deployment owner with writable package/config
directories. Disabled or unauthorized Terminals fail without choosing another
transport.

Artifacts are cached on the Jupyter side under
`~/.local/share/disclaude/jupyter-patches/<sha256>/`. Preparation saves original
and candidate bytes in a private state directory, defaulting to
`~/.local/state/disclaude-datalayer-patch/environment-<identity>/`.
`--state-dir` selects an absolute private directory. Preserve it for rollback
and use the same interpreter/path/state options for later actions.

All source fingerprints and Python syntax are checked before installation.
Every target and backup is rechecked before writes; unrelated edits or corrupted
backups are refused. Individual files are replaced atomically; the whole update
is not a transaction across files. Interrupted operations retain the phase and
original/candidate inventory for an explicit rollback. Unknown Terminal outcomes
are reported without automatically replaying installation.

`status` describes saved phases and on-disk file fingerprints. It does not claim
that the running Server uses the repair. After restarting, verify the running
execution policy and the configured-server/product cases.

### Artifact export

```sh
disclaude jupyter patch info
disclaude jupyter patch generate --output nbmodel-repair.pyz
```

The exported Python-stdlib zip application is the same payload used by Terminal.
It includes the whitelisted repair resources and upstream license with a checksum
sidecar, and excludes credentials and deployment configuration. Existing output
files are refused. Generation works in installed/prebuilt Git/npm distributions
without host Python. In a checkout use `node bin/disclaude.js jupyter patch ...`.

Maintainer checks:

```sh
node --test tests/jupyter/patch-cli-test.mjs tests/jupyter/auth-input-test.mjs
python3 tests/jupyter/datalayer-package-test.py -v
python3 tests/jupyter/auth-tty-test.py -v
```

## Hot activation

This complete repair does **not** have a supported hot activation path on the
inspected Jupyter Server 2.21.1 / nbmodel 0.2.9 installation. `patch info` reports
`hotApplySupported=false`, `serverRestartRequired=true` and
`kernelMemoryPreserved=false`; a requested `--hot` is refused before login.
The conclusion is specific to these repairs, rather than every Jupyter extension.

| Layer                         | Existing mechanism                                                                                         | Consequence for this repair                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Lab JavaScript                | Prebuilt/federated extensions avoid a frontend rebuild; a new page loads resources published by the Server | Refresh Lab after deployment; frontend installation alone does not establish server hot activation |
| Kernel user modules           | IPython `%autoreload` reloads imported user modules inside the kernel                                      | Does not reload the separate Jupyter Server process                                                |
| Server Python                 | ExtensionManager can invoke load/start hooks; it retains imported extension modules                        | Does not replace existing nbmodel instances, queues, coroutine frames or registered handlers       |
| Server development autoreload | `ServerApp.autoreload` enables Tornado autoreload                                                          | Restarts the server process and aborts in-flight requests; it is not state-preserving hot patching |

The [Jupyter Server extension lifecycle](https://jupyter-server.readthedocs.io/en/stable/developers/extensions.html)
and [ExtensionManager API](https://jupyter-server.readthedocs.io/en/stable/api/jupyter_server.extension.html#jupyter_server.extension.manager.ExtensionManager)
describe loading/starting extensions, without a migration contract for existing
nbmodel state. The inspected loader calls the cached module's loader. The repair
adds constructor state for retention, controls, contents storage and instance
identity; old objects do not acquire those fields merely by replacing files.
`kernel_worker` is imported by reference and existing coroutine frames retain
running code. Python documents that [reload leaves existing instances and external references unchanged](https://docs.python.org/3/library/importlib.html#importlib.reload).
This explains why calling reload or the extension loader is insufficient here.

[ServerApp.autoreload](https://jupyter-server.readthedocs.io/en/stable/other/full-config.html#ServerApp.autoreload)
uses [Tornado's process restart](https://www.tornadoweb.org/en/stable/autoreload.html),
which aborts in-progress requests. [IPython autoreload](https://ipython.readthedocs.io/en/stable/config/extensions/autoreload.html)
operates before kernel user-code execution. [Lab prebuilt extensions](https://jupyterlab.readthedocs.io/en/stable/user/extensions.html)
avoid rebuilding JavaScript; this alone does not promise server hot activation.

A future nbmodel hot-update hook could quiesce submissions, finish/drain existing
workers, migrate retained results/controls, replace handlers and resume against
the same kernel managers. That requires an upstream/in-process mechanism and
separate state/continuity verification; it is not implemented by this CLI.
The CLI stages and installs files through Jupyter Terminal. Installation changes
files on disk and leaves imported Server modules and existing queue workers alone.
Activation requires an external Server restart and a Lab refresh. No kernel code
or extension reload hook is used.

## Behavior and policies

- Shared documents load through the supported `get_document(create=True)` API.
  `document_cleanup_delay=None` retains initialized rooms until Jupyter stops;
  there is no permanent browser or host RTC peer. Native ydoc saves remain
  responsible for Notebook output persistence. This configuration consumes
  memory for retained documents; operators reclaim it during an explicit
  maintenance restart after saves complete. It does not preserve kernel memory
  across that restart.
- Original result GETs are non-consuming. This candidate retains terminal
  records for one hour with a global quota of 512 active/unexpired requests;
  it refuses new submissions with 429 rather than evicting an unexpired result.
  Pending requests do not expire. Recent expiration returns 410; an absent
  record returns 404. Neither response proves non-execution, and process-local
  lookup may be lost on Jupyter restart.
- Inline result/status output is bounded at 64 KiB. Complete oversized terminal
  records use the native Contents manager under
  `nbmodel-results/<kernel>/<request>.json`, with an explicit `result_artifact`
  reference and truncation flag. Those files are user-managed research artifacts;
  the request TTL does not delete them. Storage failure is reported. Source input
  has a 256 KiB limit. Scientific packages, kernels and existing files are not
  replaced by the overlay.
- Cancellation distinguishes queued, preparing, running and finished targets.
  A queued tombstone never executes; a finished target does not signal another
  request. Running interruption checks the original managed process and waits
  for native readiness before the next queue dispatch. A changed or unverified
  process is refused. Remote proxy kernels have no verified running-interrupt
  path in this candidate.
  Failed readiness preserves the original native result but quarantines that
  queue: pending requests are refused before dispatch, and new submissions
  return 409. Use an explicitly new kernel after recording memory loss; the
  worker does not silently resume on the old kernel ID.
- Results retain document/cell/source hash, source and native incarnation.
  Source changes during execution remove the old outputs from the current cell
  and leave identifiable original-request history. Unknown metadata and
  attachments remain intact. This is not a general atomic editing protocol.
- Display updates reach all registered positions of the same display ID.
  `clear_output(wait=True)` waits for the next added output; `wait=False`
  clears immediately. Client recovery checks cell/source/request/incarnation
  and output revision so it cannot write an old snapshot over a newer result.
  Read-only queue discovery advertises these policies and the server instance
  ID. Host execution can opt out of stdin explicitly; native Lab input remains
  available under the existing executor's policy.

## Native file identity

Installation and rollback change the pinned extension files and selected config.
They do not replace Notebook files or restore an older file-ID database.
The deployment owner keeps the current native file-ID database with the research
data across Server restarts and verifies existing IDs through the authenticated
file-ID API. Changed storage paths or an old database can invalidate Project
references even when Notebook files remain present.

## Verification

In the existing remote Python environment, the staged/installed regressions use stdlib unittest
and the environment's existing CRDT libraries; they do not start a local kernel
or modify a running server:

```sh
python /path/to/datalayer-runtime-test.py \
  --staged /path/to/the/patched/jupyter_server_nbmodel -v
```

The disclaude host checks actual bundled frontend modules with isolated service
fixtures and no browser/network:

```sh
node tests/jupyter/datalayer-frontend-test.mjs --bundle /path/to/patched-bundle.js
```

These component checks do not pass the six configured-server failures or
Project/Feishu/device acceptance. Run the
[configured Datalayer probes](../../tests/jupyter/README.md), then the complete
[0.6.3 release gates](../../docs/releases/0.6.3.md) on the frozen final source.
Keep the unpatched failures and distinguish observed behavior, configuration,
protocol availability and unverified conditions.
