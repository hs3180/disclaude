---
name: jupyter
description: Use a configured remote Jupyter Notebook for Python research, persistent kernel execution, data input, charts and HTML/ipynb reports. Invoke the optional Jupyter CLI when the task needs Notebook work or continuation of an existing remote run.
---

# Remote Notebook research

Use `disclaude jupyter` from the active Project directory, or pass
`--project-dir` explicitly. This CLI connects to existing remote Datalayer APIs;
it does not start Jupyter or require host Python. Read `disclaude jupyter tools`
for the current JSON input schemas and [README.md](./README.md) for setup.

1. Run `list` for Project-local references and recent run IDs, not remote inventory.
   Check its credential state; configured credentials are not an authentication probe. Use
   `link --input-file -` with `{"path":"research/analysis.ipynb"}` for an existing
   Notebook (`--path` is the shorthand), or `create` with the same JSON input for
   a new, explicitly selected remote path. Keep findings, code and conclusions
   in that remote Notebook. Project bindings remain managed by `/project`.
2. Before GPU work on two existing kernels, run `runtime-probe` for each with
   `--input-file -` and JSON `{"kernelId":"existing-kernel-id"}`. The command
   uses only fixed host-owned probe code (`store_history:false`, no cell writeback);
   callers cannot supply code and no kernel is created. Its stable
   `disclaude.jupyter-runtime.v1` result contains only a SHA-256 host identifier
   and sorted, unique GPU UUIDs. If both `host.state` and both `gpus.state` are
   `available`, any UUID intersection means same-card work is mutually exclusive;
   disjoint UUIDs may run in parallel. For example, A `["GPU-a"]` and B
   `["GPU-a","GPU-b"]` must not run together, while A `["GPU-a"]` and B
   `["GPU-b"]` may. Empty/missing/failed metadata returns `state:"unknown"` with
   `uuids:null`, never a fabricated empty list; unknown is not permission to run.
   Raw hostnames, GPU names, processes, utilization and environment values are
   deliberately not exposed.
3. Use `describe` and `read-cell` to read live shared cells by stable ID.
   Right after `create`, `describe` lists one RTC-seeded phantom empty code cell
   first — a server UUID `cellId` whose `sourceHash` is the empty-string
   SHA-256 (`e3b0c442…7852b855`); it is server seeding, not content, and the
   first appended `insert-cell` removes it (`removedSeedCellId`). Error
   previews expose `ename`, `evalue` and bounded `traceback[]`; inspect
   the recent traceback lines and any truncation flag before diagnosing code. Edit,
   move or delete only the intended cell, using its latest `sourceHash`.
   Copy the full 64-hex hash; a conflict reports expected/actual values and asks
   for a fresh read. Preserve human content. These checks remain client-side,
   not atomic server CAS.
3. Pass command arguments through `--input-file FILE` or `--input-file -`;
   every command, including `link`/`create`/`unlink`, takes one JSON object
   this way. Use a unique `runId` with `execute`; it submits once and returns
   promptly. Multiple accepted `execute` submissions to one kernel run in
   server-side submission order (per-kernel FIFO queue); an older still-queued
   request for the same `cellId` is superseded by a newer one, and the CLI
   refuses a new submission while the kernel reports busy.
   Continue with `status` for the original run. Reuse the same ID after a lost
   response; never invent a new ID to replay an uncertain execution.
   Check `source`: `live` is a current remote observation; `local-journal` is
   a saved fact or a failed client lookup. `client-error` retains the last
   confirmed state and loss time. `server-unknown` means the original record
   was queried but is missing, expired or from a changed kernel incarnation;
   it does not prove non-execution. Restore the configured connection, then
   use `reconcile` to query every nonterminal original handle without replay.
   Cached partial outputs are labelled `lastKnownResult`.
4. Stop remote work with `stop` and its original `notebookId`/`runId`. Only
   `stopConfirmed: true` confirms cancellation. Chat `/stop` stops inference;
   remote executions remain independent. Do not claim the kernel stopped
   from a cancelled tool invocation or a stopped chat.
   For work started in JupyterLab or without an available run journal, use
   `interrupt` only with the explicitly selected existing `kernelId`, or a
   Project `notebookId` whose existing kernel binding is unique and unshared.
   Supplying both IDs checks the observed binding against the selected kernel.
   This affects that kernel's current execution and preserves the kernel;
   it does not cancel one named run or confirm that queued work was cleared.
   `state: accepted` / HTTP 204 acknowledges the request only. Its
   `executionState: unknown` requires separate evidence from the original
   execution, or a subsequent kernel observation. Do not automatically retry an
   unknown interrupt or substitute it for a failed `stop`.
5. To use an incoming attachment, copy the supplied local attachment into this
   Project, then `import-file` with its Project-relative `filePath`: the path
   is resolved against the Project directory and must stay inside it —
   absolute paths, traversal out of the Project, symlinks and non-regular
   files are rejected (one file per invocation). One command covers regular
   files up to 512 MB: files above 2 MB upload in server-reassembled chunks
   and are hash-verified, and a failed or aborted import removes its partial
   remote file instead of leaving it looking complete — re-run the same
   command to retry. Read the returned hash/size and use
   `kernelRelativePath` in remote code. Host and kernel paths belong to
   separate environments. Whole directory trees and object-storage
   (S3/URL pull) transfers are out of scope; import files one by one.
6. Use `observe-image` to obtain a local image artifact and inspect that file
   with the harness's image tool. MIME names alone do not establish plot content.
   Output provenance can be historical after a source edit.
7. `export` returns links to a matching HTML/ipynb snapshot. `download-report`
   also returns persistent local files and bounded image previews. Use the
   existing channel skill to send those files with the request's chat/thread
   identifiers. Check its delivery result before claiming success; inspect an
   uncertain delivery before retrying. Cite the report revision in the summary.

Failures carry a safe layer/code and, for HTTP, a scrubbed server excerpt. Use
`--verbose` for phase diagnostics; never print raw upstream exceptions. Read
the error hint and original run status before deciding whether to continue.

Use `--no-interactive` in agent calls. The operator configures authentication
through environment variables or a private `.env`; do not read or print secrets,
put them in command arguments, Project references, Notebook cells or reports.
An unavailable connection, missing original kernel or unknown execution is a
condition to report and inspect. It does not authorize a local replacement
Jupyter environment, automatic replay or a replacement kernel.
