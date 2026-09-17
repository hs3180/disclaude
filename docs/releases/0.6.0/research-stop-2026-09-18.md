# Research in-flight stop and explicit continuation

On 2026-09-18, candidate `884610e2` temporarily ran the production Feishu bot
with an owned workspace containing the existing research checkpoint. Actual
rollout metadata confirmed `gpt-5.6-luna` for both turns. This candidate combines
main `13072902` and the current input, interruption, isolation, document-view,
receipt-boundary and resume-comment-identity changes.

The first native request resumed an existing document-led research project and
started an explicitly controlled offline read: a foreground Python process wrote
a start marker, slept for 120 seconds, then would write a completion marker.
The marker was explicitly excluded from research facts. PID 67448 was observed
running before the native `/stop` submission.

The model turn recorded `turn_aborted` with reason `interrupted`. Chat first
reported that termination was in progress, then that the turn had stopped. The
observed Python process exited, the completion marker was absent, and the original
checkpoint bytes and remote document body were unchanged. This distinguishes an
acknowledged stop request from observed process termination.

While stopped, a user API append corrected annual maintenance from 300 to 400,
retaining deployment cost 2,600 and the offline-read/write constraint. A new native
chat message only asked to read the latest document/comments and continue; it did
not repeat those values and explicitly excluded restarting the simulated read.
A new Luna turn read the change and revised the same document through revision 26:
current and detailed R5 findings show first-year total 3,000 and difference 1,560.
The user paragraph, prior R2 marker, R4 quote/history and every previously accepted
feedback record were preserved. The simulated completion file remained absent;
no simulation output was used as evidence. Final checkpoint revision 26 remained
active, with no pending write or pending feedback. Chat linked the same document.

The run retained recoverable CLI/jq construction errors before successful receipt
acknowledgement; it is not represented as an error-free tool trace. It proves this
controlled research `/stop` and explicit continuation with new body feedback.
It does not prove autonomous research, project-wide pause/cancel across concurrent
work, stopping only one live direction, abrupt service crash, permission failures,
changed comments during downtime, or complete release acceptance.

Three computer-use calls, no screenshots. The original daily service was restored,
configuration/plist hashes matched, and independent health verified the original
service deployment. Candidate processes exited; workspace and the owned temporary
ack input were archived with hashes and removed after process checks. The research
document is retained for review. No PR was merged by the agent.
