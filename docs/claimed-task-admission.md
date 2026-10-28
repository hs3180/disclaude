# Claim before executing

`prepareClaimedTask` is a host-only composition of the F7 reservation, board
projection and existing worker start port. The service supplies a canonical,
authorized task key and current revision. Each prepared attempt creates a fresh
host owner ID and private claim ID before any write. Keep that attempt object
for retries; model-supplied IDs cannot restore it after a restart.

`start()` checks current authority, atomically reserves the task, waits for
`ensureProjection` to confirm that exact owner/revision, then starts work once.
The projection port must use an already known record ID, reconcile an unknown
acknowledgement before writing again, and preserve unrelated fields. Base is a
visible projection, not the compare-and-set authority. A second worker loses
before either a remote write or native execution.

A failed claim or projection can be retried on the same prepared attempt. A
throw from native start is uncertain and cannot be retried or released through
this helper; reconcile its actual execution first. The confirmed native handle
is retained for exact repeat calls and includes physical settlement, not only a
parent model result. Cancellation before launch retains any committed claim.

`release()` is explicit. It prevents further admission, joins pending projection
and physical execution, rechecks permission and releases only the original lease.
A lost release acknowledgement retries that same lease. No expiry, automatic
failure release, worker replay, scheduler or Goal budget is added. Restart leaves
the persistent reservation held; a new owner cannot adopt it.

Default user-source authorization, actual runtime/Base ports and final package
acceptance must be composed separately. This helper does not silently borrow a
user's CLI credentials or report a remote update as confirmed without a receipt.
