# Submissions, review and rework

`TaskReviewStore` retains one task's acceptance criteria, submitted artifact
identities and independent review decisions. One owning service supplies current
authorization, authenticated submitter/reviewer execution IDs and the artifact
inspection port. Workers must not open separate stores or supply identities as
model arguments. For local files, bind `readProjectArtifact` to the authorized
Project; remote artifacts need an equivalent trusted inspection port.

Every mutation requires the current revision and a host-retained operation UUID.
Submit records the actual references/hash/byte count plus the acceptance snapshot.
Review names that exact current submission, includes a reason, and comes from a
different execution identity. Approval requires a nonempty evidence note for
every zero-based acceptance criterion. Rejection and later resubmission retain
the old submission and reason. New criteria or submissions cannot inherit an
earlier approval; late reviews fail on revision/target checks.

`get()` returns historical facts, including approval of specific bytes. It does
not assert that today's files still match. Call `verifyApproved(key, revision)`
before projecting completion: it rereads current artifact identities and checks
the revision again. Matching bytes do not prove semantic quality; the independent
reviewer's evidence and any required product/human acceptance still matter.

Private records use atomic publication, file/directory synchronization and one
canonical queue across parent directory aliases. Exact retries reconcile the
last operation after an unknown write acknowledgement without duplicating history
or rerunning a reviewer. Newer revisions require reading/reconciling the result.
Damaged records and publication failures preserve known history; storage capacity
failure does not discard older rounds.

This component creates no Goal, agent, scheduler, automatic retries or budgets.
Default tools/source checks, actual reviewer execution, Base projection and final
package/platform acceptance remain integrations. A plain Base status write is
never the store's completion proof.
