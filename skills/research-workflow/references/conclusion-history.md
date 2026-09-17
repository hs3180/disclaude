# Verify replaced conclusions

Apply this check to the exact conclusion paragraphs being replaced in the
current document, including the most recent version. Preserving an older
recommendation does not preserve the current paragraph that a new edit removes.

1. Keep a complete pre-edit snapshot using the protocol's snapshot format:
   `documentId`, `revision`, `body`, `comments`, `complete`. Reuse the exact old
   paragraph text supplied to the actual replacement operation; do not retype,
   summarize, or select an easier historical paragraph after the write.
2. Preserve that old text, its conditions and sources in the document's history
   and read it back before replacing the current recommendation. If the same
   version already exists in history, reuse it instead of adding a duplicate.
3. After the edit, fetch the complete document and construct input JSON from
   the saved snapshots and actual replaced strings. Include every conclusion
   paragraph replaced in this edit:

   ```json
   {
     "before": {"documentId":"d1","revision":"8","body":"...","comments":[],"complete":true},
     "after": {"documentId":"d1","revision":"9","body":"...","comments":[],"complete":true},
     "replacedConclusions": ["exact old paragraph used as the replacement pattern"]
   }
   ```

   ```sh
   node /path/to/research-workflow/scripts/verify-conclusion-history.mjs < history-check.json
   ```

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
