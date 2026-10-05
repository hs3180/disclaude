# Project-local Jupyter configuration

For the existing Datalayer RTC/nbmodel backend, select `backend: "datalayer"`
in the host connection catalog. The same Project reference format is used.
See [MVP setup, actual tests and unsupported requirements](../../../../docs/designs/datalayer-mvp.md).
The Datalayer session's conversation journal is separate from reference metadata;
this store does not acquire a server owner generation or promise atomic cell edits.

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
