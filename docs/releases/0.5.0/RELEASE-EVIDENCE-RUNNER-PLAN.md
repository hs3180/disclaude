# Release evidence runner follow-up

Related: #4826

The release evidence validator checks candidate identity, canonical acceptance
metadata, contained paths, record shape, and artifact hashes. It intentionally
does not execute commands or prove that arbitrary `passed`, `expected`, or
`observed` text is truthful. Its trust boundary is evidence emitted by a trusted
runner in a controlled checkout; it does not defend against an author who can
modify the validator and the rest of the repository together.

A follow-up runner should:

1. check out the exact candidate commit in an isolated worktree;
2. execute an allowlisted command matrix without a shell and capture argv,
   environment identity, exit status, test counts, and bounded output;
3. write records and artifacts beneath `tests/e2e/0.5.0/evidence/`, then invoke
   the validator against the same candidate;
4. keep credential-bearing raw logs local and emit sanitized artifacts for
   review; and
5. support one full-suite artifact referenced by multiple criteria when it
   genuinely covers them, rather than requiring duplicated logs.

Runner provenance or CI attestation can be added separately if the release
process needs resistance to evidence edited after execution.
