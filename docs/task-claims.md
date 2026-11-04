# Task claims

`TaskClaimStore` is the reservation primitive for F7. One owning service accepts
requests from all managed workers. Use one canonical key for each resource, such
as a serialized Base/table/record coordinate. The host must authorize the board,
task and worker before calling it. An owner label is not authentication.

Read `get(key)` for the current revision (zero when absent). `claim(key, revision,
owner, claimId)` grants one lease; two workers using the same revision cannot
both win. Generate and retain a UUID claimId before dispatch when an RPC response
may be lost. An exact retry returns the original lease without advancing its
revision. The public snapshot omits the claim ID and its stored hash.

`release(lease)` requires that exact owner, claim ID and revision. It preserves a
new revision and allows an exact release retry. A delayed old release cannot
release a later owner. Process restart keeps claims held; elapsed time alone
never expires or reassigns them. Reconcile prior execution before explicitly
releasing a held claim. There is no automatic stale-lock repair or force release.

Storage is private (directory 0700, records 0600), versioned, and published
atomically with file and directory synchronization. Malformed or redirected
records fail closed and remain untouched. A post-publication I/O failure can
leave a held claim: inspect it or retry the same identity, never assume failure
means the task is free. Reads of absent keys create no storage.

This is a single-service primitive, not a distributed filesystem lock: workers
and CLI processes must use the same service rather than constructing their own
stores. It neither edits Base records nor starts agents. The eventual authorized
claim endpoint must publish the lease into the existing board and admit work
only after claiming; a plain Base read followed by an owner-field write is not
an atomic claim. Remote publication and unknown acknowledgements need their own
reconciliation. This component does not claim those integrations are complete.
