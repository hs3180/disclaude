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

`disclaude jupyter patch` generates an upstream Jupyter/nbmodel repair; it is
not a separate disclaude patch distribution. Generation uses Node only. Remote
execution uses Python 3.9+ stdlib in the existing Jupyter deployment; scientific
packages are not installed or replaced.

### Existing Jupyter login

When Jupyter's POSIX Terminal is enabled, the CLI can use the existing password
or API token login, Terminal REST API and authenticated WebSocket without SSH:

```sh
disclaude jupyter patch prepare --jupyter configured --env-file /your/private/.env
disclaude jupyter patch status --jupyter configured --env-file /your/private/.env
```

`configured` reads host-private `JUPYTERLAB_HOST` / `JUPYTERLAB_PASS`. A literal
`--jupyter URL` also works. Real environment variables take precedence over
`--env-file` (Node 20.12+); without a file, environment variables work directly.
`--password-env NAME` selects another password key; `--token-env NAME` selects
token authentication. Credentials/cookies stay on the host and are not included
in shell commands, artifacts, state or output. The existing HTTP client supplies
cookie/XSRF/origin and redirect rules, respecting reverse-proxy URL prefixes.

The CLI creates/closes only its own terminal, transfers the verified artifact in
bounded PTY lines, and discovers the Server interpreter from the terminal's
process ancestry. If that is ambiguous, specify `--python`. Configuration/Lab
selection and private state options work as for a plain Python environment.
Disabled/unauthorized terminals fail without silently choosing another transport.

Terminal supports **prepare/status**, not stopping/restarting its own Server.
The REST API has no manager-independent service restart endpoint. Stop the server
with its real deployment manager, execute the prepared artifact under the same
target Python/environment and state (`apply --stopped`), then restart; SSH/systemd
or the Compose adapter can automate their respective full deployment flows.
Do not run in-place apply from a live Jupyter terminal: the complete repair needs
a server stop, and that terminates this connection. Terminal preparation is not
installation/activation or evidence of preserved kernel memory.

### Python environment over SSH

Select a remote Python environment (system Python, venv or conda) explicitly when
it differs from `python3` on the remote PATH:

```sh
disclaude jupyter patch info
disclaude jupyter patch prepare --ssh your-jupyter-host --python /your/env/bin/python
```

The interpreter determines the Python package. Jupyter's own config/data search
paths determine the Lab extension and standard shared config, respecting
`JUPYTER_CONFIG_PATH`, `JUPYTER_CONFIG_DIR`, `JUPYTER_PATH` and the environment
prefix. There is no assumed container name, environment prefix, home or deployment
directory. `--config-file /your/config.py` or `.json` selects an arbitrary startup
config, preserving existing contents/settings. Custom startup `--config` files
must be selected explicitly. `--frontend-dir` resolves multiple Lab installations;
ambiguous discovery is refused. Run as the deployment owner with its runtime
environment variables, especially for user installations.

For an existing systemd service, the CLI stops it, verifies the server is stopped,
installs the previously checked files, starts it and observes service state:

```sh
disclaude jupyter patch prepare --ssh your-jupyter-host --python /your/env/bin/python \
  --service your-jupyter.service
disclaude jupyter patch apply --ssh your-jupyter-host --python /your/env/bin/python \
  --service your-jupyter.service --restart
disclaude jupyter patch rollback --ssh your-jupyter-host --python /your/env/bin/python \
  --service your-jupyter.service --restart
```

User systemd is the default; `--system` selects a system unit and requires its
normal deployment permissions. The service must launch the selected environment.
For manually started Jupyter, Supervisor, launchd or another manager, stop the
server externally and use `apply --stopped` / `rollback --stopped`, then restart
with the existing manager. `--stopped` is an explicit operator assertion plus
checks of Jupyter runtime PID records and, on Linux, matching processes. These
checks supplement the operator's control of custom launch/runtime arrangements.
No kernel code is executed. There is no portable manager-independent restart API.

Plain-environment preparation saves exact original and candidate bytes in a
private state directory, leaving installed files/config untouched. Apply checks
all originals/backups before any writes and atomically replaces individual files
only after stopping. Rollback restores exact bytes/modes/owners and removes added
files; it does not restore an older Notebook or file-ID database. Interrupted
updates retain the phase and rollback inventory; an explicit follow-up can handle
known before/after files. Foreign edits and service-definition/environment drift
are refused. Installation is not an atomic transaction across all files: keep the
server stopped after a failed operation and inspect `status` before proceeding.

### Docker Compose

Container deployment is opt-in and discovers paths inside the selected running
container using its runtime identity and interpreter:

```sh
disclaude jupyter patch prepare --ssh your-docker-host --container your-jupyter
disclaude jupyter patch apply --ssh your-docker-host --container your-jupyter --restart
disclaude jupyter patch status --ssh your-docker-host --container your-jupyter
disclaude jupyter patch rollback --ssh your-docker-host --container your-jupyter --restart
```

`--python`, `--config-file` and `--frontend-dir` also select container paths.
Docker Compose v2 is needed only for this adapter. It builds on the immutable
original image, retains its runtime user and verifies the eight repair files.
The candidate config is merged privately and mounted at the discovered/selected
path. Python configs and JSON configs are both supported. Compose overrides may
change only the chosen image/config mount; Notebook/file-ID mounts, other
settings/services and original source files are preserved. Native file IDs need
an explicit `BaseFileIdManager.db_path` in a persistent writable directory mount
before image replacement; see [Native file identity](#native-file-identity).

The existing prepared schema-1 state remains reusable: its config target is read
from its recorded override, without assuming the old deployment directory.
Repeated apply/rollback does not recreate a matching container. Changed inputs,
resolved Compose environment, image, data mounts or multiple replicas are refused.

### Artifacts and activation

The CLI streams its generated artifact via SSH and verifies its SHA-256. The
remote cache is `~/.local/share/disclaude/jupyter-patches/<sha256>/`.
State defaults to `~/.local/state/disclaude-datalayer-patch/<target>/`; environment
targets use a discovered identity hash, Compose targets use the selected container.
`--state-dir` selects an absolute private directory. Retain state for rollback
and pass the same environment/service/path options to subsequent commands.
SSH aliases support custom ports/IPv6. Unknown transfer/switch outcomes are not
retried automatically.

To inspect/export the same Python-stdlib zip application:

```sh
disclaude jupyter patch generate --output nbmodel-repair.pyz
```

It includes the whitelisted repair resources/license and checksum sidecar,
without deployment configuration or credentials, and refuses existing output
files. It runs outside a checkout under the target interpreter. Generation works
through installed/prebuilt Git/npm CLI distributions; maintainers can use
`node bin/disclaude.js jupyter patch ...` in a checkout.

Save notebooks and close kernels before a restart. `prepare` does not stop a
service. `status` reports files/images/service observations, not product acceptance.
Refresh Lab after activation and verify the running execution policy and required
configured/product cases. The pinned nbmodel/Lab versions still apply; directory
portability does not establish compatibility with unverified versions.

Maintainer checks:

```sh
node --test tests/jupyter/patch-cli-test.mjs
python3 tests/jupyter/datalayer-package-test.py -v
```

## Hot activation

This complete repair does **not** have a supported hot activation path on the
inspected Jupyter Server 2.21.1 / nbmodel 0.2.9 installation. `patch info` reports
`hotApplySupported=false`, `serverRestartRequired=true` and
`kernelMemoryPreserved=false`; a requested `--hot` is refused before SSH.
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
The CLI prepares without interruption, then stops/restarts through the selected
manager or applies after an external stop. It does not write into a live installed
package or inject code into user kernels.

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

## Build and rollback

Run the following on the existing remote Docker host from a full source checkout,
with this directory as the build context. The disclaude distribution includes the repair resources and CLI generator. Use a local image
tag verified against the actual saved image ID, and the original runtime user; do not
replace a GPU/scientific environment with a fresh generic Jupyter image.

```sh
docker build --build-arg JUPYTER_BASE_IMAGE=<saved-existing-image> \
  --build-arg JUPYTER_RUNTIME_USER=<existing-user-or-root> \
-t <private-candidate-tag> .
```

The configured baseline had no Plotly package. An optional report fixture uses
[Plotly 7.1.0](https://pypi.org/project/plotly/7.1.0/) and its Narwhals dependency,
pinned with universal-wheel hashes in `reporting-requirements.txt`. Narwhals
retains the existing 2.22.1 version; Plotly is the added package. Build with
`--build-arg INSTALL_REPORTING_DEPS=1` only for that candidate. Installation uses
`--no-deps --require-hashes` and runs `pip check`; compare every existing
distribution and scientific package against the saved inventory. This option
adds remote report packages without installing Python on the disclaude host.
The default overlay build does not install them. Record additions separately
from the unchanged original distribution versions and retain the original image.

The installer checks every fingerprint and Python syntax before writes. Run it
only in a new image or an owned staging tree, never over a live package directory.
`python install.py --check` verifies a baseline or an already applied overlay
without changing it. Explicit `--package-dir` / `--frontend-dir` select owned
staging roots for tests. The default locates the installed package and exactly
one installed Lab extension.

Before switching, retain Compose/configuration, the existing image reference,
package/environment inventory and data mounts. Check live user workloads,
record the actual interruption and preserve scientific dependencies and files.
Change only the same service's candidate image, keeping authentication and
Notebook mounts. Reload Lab pages to load the new client. Restore the recorded
image/configuration to roll back and verify health and file preservation.

The deployment adapter merges repair traits into the selected shared/configured
Python or JSON config, retaining other settings. A manual image build must also
arrange that config before activation. Extension discovery files under `jupyter_server_config.d` do
not establish that arbitrary trait values were loaded. Verify the running
queue's advertised retention/quota and the loaded ydoc cleanup policy before
acceptance; a recipe or config file alone is insufficient evidence.

## Native file identity

The native file-ID database must survive image replacement as well as Notebook
files. Its default `jupyter_data_dir()/file_id_manager.db` may be in the
container's writable layer; restoring an older image can otherwise invalidate
new Project references even when Notebook files survive.

Before recreating an idle service, take a coherent SQLite backup of the current
database and verify its integrity and sorted ID/path rows. Retain that current
database on a private persistent **directory** volume, including any journal
files. Set the supported `BaseFileIdManager.db_path` trait to its absolute mounted
path in the standard shared `jupyter_config.json`, preserving other settings.
Keep separate candidate and original shared configs; both use the same database
path, while the rollback config preserves the original traits. Do not restore
the old image's database over newly created identities.

Record the extra database-directory and read-only config mounts explicitly.
Preserve the original environment, command, entrypoint and data mounts, and
retain private deployment backups. After switching or rolling back, verify
health, SQLite integrity/row fingerprint and existing document IDs through the
authenticated native file-ID API. A config file alone does not establish that
the running service uses it.

## Verification

Inside the remote image, the staged/installed regressions use stdlib unittest
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
