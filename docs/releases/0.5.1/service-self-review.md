# #4925 self-review

Scope: the full diff against `dbbd2a1c`, including renamed source, deleted APIs,
configuration, deployment, packaging, tests and documentation. This is an author
self-review, not an independent approval. CI results are linked from [the PR](https://github.com/hs3180/disclaude/pull/4925).

## Findings corrected

1. **P1 — Docker health check matched the wrong process path.** Switching from a
   private entry to the public CLI changes the child command line to
   `node_modules/@disclaude/service/dist/cli.js`. The initial refactor still
   checked `packages/service/dist/cli.js`, so a healthy container would be
   reported unhealthy. Dockerfile and Compose now match the actual child path;
   `[n]` prevents the shell probe matching itself. A regression test launches
   the real public wrapper, reads the configured Compose pattern, invokes
   `pgrep`, and asserts that it finds the launched service child's PID.
2. **P2 — The upgrade rehearsal passed a non-executable private JS entry to
   launchd.** The candidate now uses `bin/disclaude.js`. A temporary executable
   adapter is used only for the historical baseline; no legacy command is
   installed or exported. Runtime provenance handles both layouts. A real
   isolated baseline install → candidate upgrade → baseline rollback passed
   health and workspace-preservation checks, and the test service was unloaded.
3. **P2 — Mechanical renames rewrote historical evidence.** Restored the seven
   changed 0.5.0 release records and the previous live-channel verification
   report. Those records must retain the names of the code actually tested.

The earlier CI-only Vitest RPC timeout was also corrected: remote installation
uses asynchronous subprocess waiting, keeping the worker event loop responsive.
The installation and lifecycle assertions themselves were not relaxed.

## Review coverage

- Compared tokenized TypeScript before/after with explicit rename mappings:
  91 source files are comment/naming-only; 22 require substantive inspection
  (including exports/types and user-facing text). Deleted files were inspected
  separately. The service barrel that Git shows as delete/add preserves its
  debug-service exports.
- Traced service construction, channel wiring, shutdown, scheduler initialization,
  harness selection, card prompt resolution and control commands. The removed
  card router was never registered by production callers; its callback was not
  wired by channel descriptors. The live interactive store and local card
  pipeline remain. Session keys, workspace paths and persisted data formats are
  unchanged; the session-pool implementation differs only in naming/comments.
- Checked old configuration rejection and its migration guide, diagnostic-only
  `instanceId`, removed public exports/bin, workspace/lockfile references,
  launchd legacy-plist protection, and public CLI argument/signal forwarding.
- Reviewed Git distribution import rewrites, resource/dependency allowlists,
  source fingerprint, absence of old package/bin and the real remote installation
  tests. The review fixes touch Docker, rehearsal tooling, docs and tests only;
  they do not change the fingerprinted runtime in remote candidate
  `5c77edf3c87684c656099066ea3737c86f6e2bca`.
- Targeted post-review regressions: 4 files / 47 tests passed. Before these two
  new regressions, full local coverage passed with 4675 tests, 90.54% statements
  and lines, 89.42% branches and 93.54% functions. Updated full CI runs on the PR.

## Remaining release gates

No additional blocking code defect was identified in this review. This is not
a claim of exhaustive correctness or release approval. The complete Docker
image has not been built/run on this host (Docker is unavailable); the process
probe test is not a substitute for container acceptance. Formal `v0.5.1` tag
creation and exact tag-install acceptance remain unperformed. #4924 / #4922
remain open for those release checks. No production service or user data was
modified by the rehearsals.
