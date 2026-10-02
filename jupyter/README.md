# Managed Notebook coordinator

This optional server package implements the shared Notebook document and
execution ports used by disclaude. It has no Harness dependency: DSH registers
the common Notebook tools through its native registry; other adapters can use
the same ports. Installing ordinary chat packages does not install Python or
start Jupyter.

The package is an implementation candidate. Service/Feishu binding, complete
Notebook editing and report delivery are still being integrated. Component
checks do not establish product acceptance.

## Supported candidate environment

Use a separate, owned Python environment and configuration. The candidate pins
Jupyter Server 2.21.1, JupyterLab 4.6.3, collaboration 5.0.4, server-ydoc 3.0.4,
docprovider 3.0.4, ydoc 4.1.1, pycrdt 0.14.8, nbmodel 0.2.9, jupyter-client
8.10.0, ipykernel 7.4.0 and nbformat 5.11.1. The server refuses unverified
versions of the RTC internals it uses. POSIX local kernel provisioners are the
initial support boundary; Windows, remote provisioners and existing external
instances need separate evidence.

Install this directory into that environment:

```sh
python -m pip install '/path/to/disclaude/jupyter'
```

Configure only the owned server, with an authenticated entry and private state:

```python
c.ServerApp.jpserver_extensions = {
    'jupyterlab': True,
    'jupyter_server_fileid': True,
    'jupyter_server_ydoc': True,
    'jupyter_server_nbmodel': False,
    'disclaude_jupyter': True,
}
c.YDocExtension.server_side_execution = True
c.NotebookExtension.ledger_path = '/owned/private/data/notebooks.sqlite3'
c.NotebookExtension.idle_seconds = 60
c.NotebookExtension.max_rooms = 16
```

The original nbmodel server routes must be disabled: both route implementations
cannot own execution. The existing Lab frontend's server-side Run protocol is
handled by this coordinator. It uses Jupyter's native kernel client and manager;
it does not implement a new kernel WebSocket protocol. Enabling the extension on
an existing user server is not an automatic setup or compatibility check.

The state directory belongs to this server. A separate owner lock permits one
writer; namespace, controller generations, native request IDs and run records
live in SQLite. Preserve that directory and the Jupyter authentication session
when resuming a connection. It contains execution source and bounded outputs
and must be treated as private workspace data.

## Host client and authentication

`JupyterCoordinatorClient` implements `JupyterNotebookPort` and
`JupyterExecutionPort`. Its connection contains a host-owned Authorization
resolver, HTTPS base URL (loopback HTTP is allowed for owned local operation),
connection ID and optional saved server namespace. Remote URLs with credentials,
queries or fragments and redirects are rejected.

Jupyter's default token authentication generates an identity and preserves it in
a login cookie. The client keeps a connection-specific `tough-cookie` jar and
coalesces its first handshake before Notebook operations, so claim/edit/run use
the same authenticated principal. Hosts may supply a dedicated private jar when
they manage connection persistence. Cookie/domain/path/expiry handling uses the
library; cookie counts, header sizes and response bodies are bounded. Neither
credentials nor cookies enter Notebook identities or model tool descriptors.
The connector requires a Node runtime with `Headers.getSetCookie` (Node 20+).
Password login and automatic credential refresh are not yet implemented.

The host must bind tools to its claimed controller generation and recheck it at
operation boundaries. Reading the global controller does not authorize a host
to adopt a different owner's current lease. Native invocation IDs are tracing
metadata; Jupyter run IDs and kernel incarnations are business identities.

## Document and execution semantics

- Online reads and edits use the native shared document, including synchronized
  unsaved edits. An edit checks the full document revision, exact UTF-8 source
  hash and principal/controller generation, then mutates one shared Text in a
  single transaction without an intervening await.
- Document revisions hash the native canonical Notebook content, including all
  cells, metadata, attachments and outputs. They survive unchanged cold loads;
  room client IDs, dirty flags and awareness do not create content versions.
  This is content equality, not an edit-history counter. Duplicate cell IDs
  reject operations; reads do not silently deduplicate or alter them.
- Passive native room leases retain active work, force native save before idle
  release, and cold-load on later access. In-flight cold loads reserve capacity,
  document mutexes are released, and failed saves retain authoritative state
  with bounded retries and visible diagnostics. Shutdown closes every owned
  peer even when a save is unconfirmed. The room limit applies to this
  coordinator's leases; it does not claim to cap human browser resources.
- A run ID and native message ID are recorded before sending. Reusing a run ID
  with a different target/source rejects; a lost response is queried by the
  original run ID and never authorizes automatic resubmission.
- Runs serialize in one local kernel. The coordinator matches shell reply and
  IOPub parent message ID/idle, preserves source/owner/kernel provenance, and
  rejects stale writes. Kernel process identity must remain verifiable;
  uncoordinated execution invalidates authority instead of being silently
  adopted.
- Stop targets the stored run and current principal/controller generation. An
  interrupt acknowledgment is not confirmation: cancellation requires the
  terminal native observation. Stopping inference is a separate operation.
- Server restart marks unfinished runs unknown and does not replay them.
  Notebook persistence does not prove that kernel variables survived.

## Remaining acceptance work

The current tools cover cell read/edit/submit/status/stop. Creation, structured
insert/delete/move, full report/graph observation, versioned export and Feishu
data/result delivery remain required by the product issues. Also pending are
the complete restart/auth/network fault matrix, shared Lab interactive input,
cross-run display updates, late-output reconciliation, full queue-stop behavior,
large-output artifact delivery and visible result validity after source/kernel
changes. Output truncation in this candidate is not full artifact acceptance.

Tests of the Lab HTTP Run protocol are not native Lab UI acceptance. Final
acceptance must use the same server Notebook from Feishu, preserve human edits,
confirm kernel stop, continue the same research, and deliver accessible results
from the user's actual device. Daily/candidate defaults remain `gpt-6-luna`;
the explicitly specified real-model acceptance uses `gpt-5.6-luna`.

## Opt-in checks

Install test dependencies into the same separate environment:

```sh
python -m pip install -e './jupyter[test]'
PYTHONPATH=jupyter python -m unittest discover -s jupyter/tests -v
npm run build --workspace=@disclaude/core
npx vitest --run packages/core/src/jupyter/coordinator-client.test.ts
python tests/jupyter/coordinator-probe.py --output /private/new-backend-report.json
```

The probe creates and removes its own authenticated local server, Notebook,
kernel, state and settings. It uses no existing user server or Project mount.
Each report path must be new; reports preserve failures and have mode 0600.
For actual DSH composition, supply an independently built native adapter
checkout, explicit model route credentials and binary:

```sh
python tests/jupyter/coordinator-probe.py \
  --output /private/new-native-report.json \
  --dsh-checkout /path/to/native-adapter-worktree \
  --dsh-binary /path/to/dsh \
  --oauth-auth-file /private/existing-auth.json \
  --model gpt-5.6-luna
```

This reads an existing unexpired access credential without refreshing it or
writing back. Native and backend source fingerprints distinguish uncommitted
candidate code from published commits. No UI or production bot is used by this
component probe.
