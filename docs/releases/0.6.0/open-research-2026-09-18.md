# Open research and conclusion preservation — incomplete

This records new evidence and two actual failures. It does not certify full
Agentic Research UX or 0.6.0 delivery.

## Native Feishu investigation

Candidate `a055e876f78d7d5b8ad40f8cde9d0c0ac864ecd7` used `gpt-5.6-luna` to
research SQLite FTS5 versus Tantivy for mixed-language offline notes. A human
message entered through the native Feishu input requested primary-source
investigation and reproducible experiments, without supplying a conclusion.
The bot used the existing project binding and this
[research document](https://up5wa1znxs.feishu.cn/docx/WDT7dWQ1doh0CEx5yUCcio5fnMh).

The first turn consulted official SQLite/Tantivy documentation and ran a SQLite
SQL fixture. It distinguished untested Tantivy/performance claims from observed
SQLite behavior and retained active research state. Independent document
revision 4 matched checkpoint version 4 with no pending feedback/write.

Two problems remained:

- The deletion experiment checked only a zero result after deletion. Its Chinese
  query did not match before deletion either, so it did not prove removal.
- The report linked a SQL file inside the local project rather than exposing its
  complete content to a Feishu reader.

A second native message supplied a two-character substring counterexample,
requested case/accent checks and positive-before/negative-after deletion checks,
stopped future Tantivy integration/performance-ranking work, and asked for the
complete script in the document. The bot actually modified and reran its SQL,
embedded it with environment/conditions/results, and narrowed its recommendation
to a recall prototype with explicit fallback limitations. It did not start new
Tantivy integration. This demonstrates a change of future research direction,
not cancellation of an observed in-flight Tantivy process.

Independent revision 8 matched its checkpoint and contained the updated script
and interpretation. However, comparing revisions 4 and 8 showed that the first
recommendation paragraph had disappeared. The new history section and final
chat incorrectly claimed that prior conclusions remained. This is a failed
history-preservation requirement, not a complete open-research pass.

The actual model reported SQLite 3.50.4. An independent Python SQLite 3.43.2
control confirmed the deletion-test flaw: `上海` had zero hits both before and
after, while `offline` changed from one to zero. A separate Apple CLI 3.43.2
replay failed its trusted-schema precondition; it is retained and is not treated
as a same-environment reproduction of the model's complete experiment.

Computer use: 3 calls total (app selection and two native inputs), zero
screenshots. Production candidate interval: 2026-09-17 22:30:03–22:40:53 UTC.
Original config/plist hashes were preserved; original service restored and
independently healthy; candidate files archived and owned root removed.

## Instruction-only follow-up also failed

Instruction change `475fb2e9` was exercised on integration
`2b46935cdeb7adf8de33b6b5ab97489de59bf755`. A separate REST-only Luna instance
read the two original local reports and the same document. It was asked to
verify historical completeness and narrow the current recommendation further,
without new experiments or resumed Tantivy work.

The bot restored the first recommendation verbatim, then replaced the second
recommendation without retaining that exact paragraph. It again claimed that
both historical judgments were preserved. Independent revision 11 matched
checkpoint version 12 (active, no pending write/feedback), but the second
recommendation's text was absent. Correct checkpoint synchronization alone
therefore does not prove preservation of document history.

This follow-up used no computer use and did not switch the production service.
Its owned REST instance exited; 13 external temporary paths were archived,
hash-verified and removed; no candidate files remained open and production kept
its healthy instance. Auxiliary model-written task-duration estimates are not
used as elapsed-time evidence.

## Deterministic read-back check

PR #5112 adds a read-only `verify-conclusion-history.mjs` check. The agent must
supply every actual replaced paragraph and complete before/after snapshots.
The check rejects a missing paragraph even when an older recommendation or a
claim of preservation remains. It does not edit documents, manage tasks, or
introduce TASK.md/schema/indexing conventions.

Five regression tests pass. Replaying the saved real revisions detects both
losses and accepts the first paragraph that was actually restored in revision
11. Skill validation passes. All six CI checks passed on implementation
`c92411e7`.

## Actual Luna verifier follow-up

Integration `f1d52db021eaf99b8638df1a3fae16238eacf7c8` continued the same task and
document through a REST-only `gpt-5.6-luna` instance. It compared the three
original complete reports, restored the missing second recommendation, and
saved the third recommendation before replacing the current text. Revision 12
read-back confirmed that history existed before replacement. The model actually
ran the verifier on the latest replaced paragraph and the complete before/after
snapshots; it passed at revision 13.

Independent final revision 14 matches checkpoint version 16 byte-for-byte, with
active status and no pending write or unresolved feedback. All three original
recommendation paragraphs occur exactly once; previous receipt IDs also remain
exactly once. The complete SQL block and local SQL file are unchanged. The new
current recommendation explicitly leaves Unicode normalization boundaries,
index-update completeness and real-scale performance unverified. Final chat
links the original document. A local acknowledgement-input error was corrected
without repeating the remote append.

The verifier proves retention of supplied paragraphs only. Independent audit of
all three original recommendations supplies the broader history check for this
round; the tool cannot discover omitted replacement inputs or certify new
findings. This repair passes the scoped history-preservation acceptance and
does not erase either previous failure or certify complete open-research UX.

This round used zero computer-use calls/screenshots and did not interrupt the
daily service. The candidate exited cleanly with no open files; independent
health confirmed the original daily service instance remained healthy.

Local evidence: `.local/060-poll/open-research-*`,
`luna-open-research-*`, `research-history-*`, `conclusion-history-replay.json`,
and `history-verifier-*`. Native in-flight cancellation, broader document
feedback/failure UX and final integrated release acceptance remain separate
uncompleted gates.
