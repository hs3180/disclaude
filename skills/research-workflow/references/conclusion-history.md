# Verify replaced conclusions

Apply this check to the exact conclusion paragraphs being replaced in the
current document, including the most recent version. Preserving an older
recommendation does not preserve the current paragraph that a new edit removes.

1. Keep a complete pre-edit snapshot using the protocol's snapshot format:
   `documentId`, `revision`, `body`, `comments`, `complete`. Extract the whole
   current conclusion paragraph from its exact body; do not retype or summarize.
2. Generate one replacement from the complete snapshot, old paragraph and new
   paragraph. This applies to scope-only feedback while paused as well as new
   research findings:

   ```json
   {
     "before": {"documentId":"d1","revision":"17","body":"...","comments":[],"complete":true},
     "previousConclusion": "exact whole current paragraph",
     "nextConclusion": "new current paragraph"
   }
   ```

   ```sh
   node /path/to/research-workflow/scripts/prepare-conclusion-replacement.mjs < revision-input.json > replacement.json
   ```

   The output contains `pattern`, `content` (new paragraph followed by the old
   paragraph under a versioned history heading), and `historyCheck`. It performs
   no file or remote writes. It rejects partial, absent, duplicated and
   multi-paragraph patterns. If the old paragraph already exists elsewhere,
   inspect its location and use the existing verified history; do not delete
   history to make the assembler accept a pattern.
3. Re-read immediately before mutation and confirm the paragraph and surrounding
   context still match. Pass the generated `pattern` and `content` to one
   targeted document replacement, using structured arguments or a subprocess
   argument array. Do not interpolate JSON into shell commands, reconstruct the
   payload, or write only the new paragraph. Keep its history heading visible
   below the new current conclusion. Never replace the entire document.
4. Fetch the complete document after the replacement. Add this snapshot as
   `after` to the returned `historyCheck` object and verify:

   ```sh
   node /path/to/research-workflow/scripts/verify-conclusion-history.mjs < history-check.json
   ```

The assembler reduces the update to one provider operation; it is not a remote
transaction or version lock. On a timeout or uncertain response, read back
before retrying. If both the generated replacement and old history are already
present, verify that result rather than applying the replacement again.

The check is read-only. It requires each original paragraph to exist in the
pre-edit body and the same text to remain in the final read-back. A preservation
claim, a paraphrase, or a different older recommendation cannot satisfy it.
Use consistent full Markdown snapshots; do not trim away a discrepancy to make
the check pass. On failure, preserve the evidence, restore only text supported
by the original snapshot/report, fetch again and rerun the check before claiming
that history is intact.

This only checks the supplied paragraphs. It does not discover omitted edits,
prove that new conclusions are correct, verify links/permissions, or lock the
remote document. Supply actual replacement inputs and separately verify the
current recommendation, evidence and checkpoint against the final read-back.

## Historical snapshot audit

Use this path when asked to check or restore history, including turns that do
not replace a current conclusion. Pass all available complete source snapshots
and the complete current snapshot to the missing-block report:

```json
{"sources":[{"documentId":"d1","revision":"17","body":"...","complete":true}],"current":{"documentId":"d1","revision":"27","body":"...","complete":true}}
```

```sh
node /path/to/research-workflow/scripts/compare-snapshot-history.mjs < snapshot-history.json > missing-history.json
```

Build snapshots from original responses without rewriting their text. The
report compares blank-line-separated text blocks, groups identical missing
blocks and lists their source revisions. It reports changed headings/status
metadata too; it does not decide which differences are historical conclusions,
parse Markdown semantics, or certify completeness. Read each reported block:
keep legitimate current-state metadata changes, but restore missing conclusions
verbatim from the indicated source, including conditions and citations. Do not
use section titles, similar older text or model memory as a substitute.

Append verified missing historical paragraphs with their source revision;
do not overwrite the current recommendation. Read back, rerun the comparison,
and explain any remaining metadata-only differences. Finally pass all required
historical conclusion paragraphs to `verify-conclusion-history.mjs` against
their original source snapshots and final read-back. A disappearance can be
fixed without a new experiment or resuming a paused research task.
