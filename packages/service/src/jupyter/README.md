# Project-local Jupyter configuration

Remote Notebook operations are provided by the optional
[Jupyter CLI Skill](../../../../skills/jupyter/README.md). `cli.ts` owns one
command invocation, and `notebook-tools.ts` owns its temporary RTC connections
and Project-local run facts. Neither module is imported by ChatAgent or service
startup. Report files are delivered separately through the channel CLI.

Jupyter reference metadata belongs to the Jupyter integration. It is stored at
`<workingDir>/.jupyter/config.json`, independently of the generic ProjectManager
and its chat-to-directory bindings.

```json
{
  "version": 1,
  "notebooks": [
    {
      "connectionId": "jupyter-local",
      "serverNamespace": "server-1",
      "documentId": "server-issued-document-id",
      "contentPath": "research/analysis.ipynb",
      "lastKnownVersion": "verified-revision"
    }
  ]
}
```

`JupyterProjectConfigStore` receives a working directory directly. An integration
caller can obtain that directory from `ProjectManager.getActive(chatId).workingDir`;
ProjectManager does not import Jupyter types, load Jupyter files, or manage references.
Changing the directory selects a different configuration file. Chats using the
same directory share the same file, and moving the Project directory carries its
reference metadata with it.

`listNotebookReferences()`, `linkNotebook()` and `unlinkNotebook()` reread the
file on each operation, including manual edits and sequential updates by other
store instances. Reading an absent file returns an empty list without creating
anything. Writes replace the file atomically through a unique temporary file;
invalid or unsupported configuration returns an error and is left untouched.
This is not a lock or compare-and-swap protocol for concurrent file writers.

Only the listed notebook reference fields are persisted. Connection credentials
are configured separately, and notebook content remains on the Jupyter server.
`documentId` and `lastKnownVersion` are optional: an unresolved reference uses its
service-scoped Contents path as its key. A verified stable ID is required by the
collaboration/execution contract before operations on a remote document. Renaming
a reference with a stable ID updates it in place; distinct server namespaces,
connections and document IDs remain separate.

This module only reads and writes local reference metadata. It does not connect
to Jupyter, manage authentication, synchronize RTC state, edit cells, coordinate
ownership or execute kernels. Unlinking a reference does not delete the remote
notebook or stop a kernel. The previous unmerged PR's workspace-wide
`.disclaude/project-jupyter-references.json` prototype is no longer read or written;
there is no automatic migration of that prototype file.

`disclaude jupyter status` queries the original request handle and reports
`source: live`; a cached terminal result or failed client lookup instead reports
`source: local-journal`. A connection/authentication failure returns `client-error`.
An actual missing/expired request or changed kernel incarnation returns
`server-unknown` with its query time and reason. Neither state proves that the
original code did not execute.

The journal retains the last confirmed execution state and observation across
failed lookups. `lastConfirmedRunningAt`, `lostAt`, `checkedAt`, and up to 32 loss
diagnostics distinguish the last running fact from a later connection problem.
Cached partial output is explicitly labelled `lastKnownResult` rather than a live
result. Old journals remain readable; a legacy unknown record cannot reconstruct
running facts that the older client already overwrote.

After restoring connection credentials, `disclaude jupyter reconcile --project-dir
DIR` reads every nonterminal original handle in that Project. Individual `status`
queries also retry the same lookup. Reconciliation never submits cells, restarts
kernels, or replays uncertain executions. A reservation without a trustworthy
request handle reports `client-error / request-handle-unavailable`; it cannot
claim a live query or safely infer non-execution. Confirmed terminal results stay
available from the journal even when the remote result has expired.


## CLI diagnostics and credential discovery

Notebook CLI failures expose a structured `error` with a safe layer/code,
message/hint and optional HTTP status/body excerpt. Core transport classifies
network errors by native codes, keeps raw fetch errors private, and scrubs
host-resolved credentials and current cookies before exposing selected server
error fields. HTML and arbitrary JSON/traceback fields are omitted. Mutations
remain single-submit; an HTTP error does not prove an execution never started.
`--verbose` reports credential/HTTP phases without headers or secret values.

The host auth helper discovers cwd, explicit Project, an existing disclaude
workspace binding marker and the environment workspace in order. It selects
one relevant env file; it does not merge profiles or initialize agent config.
Explicit files and unreadable selected files never fall back silently. Only
source labels/path metadata cross the CLI boundary. `list` remains local and
labels remote inventory/authentication as not queried/checked, including an
explicit unresolved-credential state.

Full SHA-256 validation runs before `useClient`; malformed hashes have a CAS
input diagnostic. Observed source conflicts preserve `state/sourceHash` and
add expected/actual values and a re-read hint. This does not strengthen the
existing client-side check into an atomic server CAS. The owned HTTP fixture
`tests/integration/jupyter-diagnostics.mjs` performs no configured-server or
kernel execution; it is protocol evidence, not a new product acceptance.
