# Active research end-of-turn synchronization

PR #5110 follow-up. Tested local integration
`af8aed6b1c3567feb4afe39b3afd425362c5c188`, including instruction change
`aa5ecce2`, the existing Feishu Markdown acknowledgement boundary, and #5111's
append-only execution records. These are controlled materials, not open research
or full 0.6.0 acceptance.

## Failure preserved

The preceding concurrent research artifacts exposed two different gaps:

- A: checkpoint version 4 retained document revision 3, but the independently
  read document was revision 4. The substantive findings were not saved in the
  checkpoint body, even though no feedback was pending locally.
- B: checkpoint version 8 matched document revision 11 but retained one pending
  body-feedback item from its own substantive update.

The instructions allowed substantive edits after a receipt and required a final
sync only before research completion. An active turn could therefore end stale.
The originals remain in `.local/060-poll/luna-concurrency-evidence`; they were
copied as-is into the follow-up candidate before adding new source corrections.

## Actual Luna follow-up

A loopback REST-only candidate resumed two bound projects on 2026-09-17 at
22:18–22:23 UTC. Both rollout contexts used `gpt-5.6-luna`. The existing task and
Feishu document bindings were preserved; the previous probe was not rerun.
The prompt supplied a new material correction for each project and kept research
active. No production bot connection, service switch, or computer-use call was
needed.

| Project | New result | Final checkpoint | Independent document |
| --- | --- | --- | --- |
| [A](https://up5wa1znxs.feishu.cn/docx/QlGJdmAQ7oKIttxXh6Icz2sSnIg) | Initialization 104; Jasper 308/year vs Lime 504, saving 196 | version 12, active, no pending write/feedback | revision 15, exact saved body/hash match |
| [B](https://up5wa1znxs.feishu.cn/docx/Z7iod2RM4oy95xxaGoHcP7shnsf) | 210 pages/month; Rhea 126 vs Sora 88, saving 38 | version 12, active, no pending write/feedback | revision 16, exact saved body/hash match |

Prior accepted feedback and comment identities/text remain unchanged. All prior
receipt IDs remain present once. A retains 80/100 initialization history; B
retains 120/200-page history. Current summaries and detailed calculations agree;
unknown costs remain explicitly unknown. Both final replies link the original
document and keep research in progress.

A needed two new receipts: the second followed a further formatting correction
after its first acknowledgement. This was an additional verified body revision,
not replay of an old receipt. B needed one new receipt. A recovered from a local
JSON-input mistake without repeating its append; B's unsupported `--cwd` record
argument was rejected before a corrected append. Auxiliary estimated/actual time
claims in model-written execution history are not used as timing evidence.

The final complete read-backs were saved by successful `ack`, with no later
remote writes. The models did not perform an additional redundant `sync` after
those final acknowledgements. The follow-up documentation explicitly permits
that equivalent closing check: `ack` already stores the complete snapshot.
Edits made after it still require another complete fetch/sync. This does not
allow a local status read alone to establish remote freshness.

## Validation and boundaries

20 branch tests / 22 integrated checkpoint and converter tests passed; skill
validation and integrated build passed. A saved-artifact fixture confirms that
an unchanged final sync adds no feedback, while a late comment remains pending.
The fixture made no remote calls and does not prove live concurrent-edit handling.

Independent CLI reads matched both final checkpoint bodies, revisions, hashes,
and original bindings. The candidate exited; no open files remained. Seven
model-created external temporary paths were copied, hash-verified and removed.
The original daily service retained its instance and passed a health check.
Computer use: **0 calls, 0 screenshots**.

Raw evidence is retained in `.local/060-poll/research-endturn-*` and the owned
`luna-endturn-retest-*` directory. Final-source open research, native Feishu
control UX, broader concurrent edits/permissions/failure handling, and release
acceptance remain separate unfinished gates.
