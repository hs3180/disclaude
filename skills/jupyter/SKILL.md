---
name: jupyter
description: Use a configured remote Jupyter Notebook for Python research, persistent kernel execution, data input, charts and HTML/ipynb reports. Invoke the optional Jupyter CLI when the task needs Notebook work or continuation of an existing remote run.
---

# Remote Notebook research

Use `disclaude jupyter` from the active Project directory, or pass
`--project-dir` explicitly. This CLI connects to existing remote Datalayer APIs;
it does not start Jupyter or require host Python. Read `disclaude jupyter tools`
for the current JSON input schemas and [README.md](./README.md) for setup.

1. Run `list` to discover this Project's references and recent run IDs. Use
   `link --path research/analysis.ipynb` for an existing Notebook, or `create`
   for a new, explicitly selected remote path. Keep findings, code and conclusions
   in that remote Notebook. Project bindings remain managed by `/project`.
2. Use `describe` and `read-cell` to read live shared cells by stable ID. Edit,
   move or delete only the intended cell, using its latest `sourceHash`.
   Preserve other cells and human notes. These source checks are client-side.
3. Pass command arguments through `--input-file FILE` or `--input-file -`.
   Use a unique `runId` with `execute`; it submits once and returns promptly.
   Continue with `status` for the original run. Reuse the same ID after a lost
   response; never invent a new ID to replay an uncertain execution.
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
   Project, then `import-file` with its Project-relative path. Read the returned
   hash/size and use `kernelRelativePath` in remote code. Host and kernel paths
   belong to separate environments.
6. Use `observe-image` to obtain a local image artifact and inspect that file
   with the harness's image tool. MIME names alone do not establish plot content.
   Output provenance can be historical after a source edit.
7. `export` returns links to a matching HTML/ipynb snapshot. `download-report`
   also returns persistent local files and bounded image previews. Use the
   existing channel skill to send those files with the request's chat/thread
   identifiers. Check its delivery result before claiming success; inspect an
   uncertain delivery before retrying. Cite the report revision in the summary.

Use `--no-interactive` in agent calls. The operator configures authentication
through environment variables or a private `.env`; do not read or print secrets,
put them in command arguments, Project references, Notebook cells or reports.
An unavailable connection, missing original kernel or unknown execution is a
condition to report and inspect. It does not authorize a local replacement
Jupyter environment, automatic replay or a replacement kernel.
