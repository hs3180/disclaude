# Research document feedback: scoped pass and stale overview

Candidate `ad2c4945` combined main `a568158e` with input, interruption, directory
isolation, contextual-feedback, mention and test-runner changes. The real daily
Feishu bot was temporarily switched to an owned workspace on 2026-09-18. Actual
rollout metadata confirmed `gpt-5.6-luna`. Native chat submissions and API document
readback supplied the evidence; there were three UI calls and no screenshots.

The user supplied fictional Atlas/Birch/Cedar materials and requested a persistent
research document. The first turn created one document, preserved source material,
separated facts/inferences/unknowns and returned its stable link in chat. Initial
nominal annual costs were 1,440/2,200/2,880; Atlas was initially recommended.

The test user then appended a hard offline read/write requirement and stopped
further Cedar investigation in the document, including an exact preservation
marker. A second native chat message only asked the agent to read the latest
body/comments and continue the same document; it did not repeat the constraint.
The agent read revision 4, then appended revision 5 recommending Birch because
it was the only option explicitly supporting offline read/write. The original
material, initial recommendation and test user's paragraph remained intact.
The revision recorded Cedar as no longer under investigation. This is a scoped
content/feedback pass, not proof of stopping an already-running investigation.

The overview failed: the opening status still said initial stage and displayed
Atlas as the initial recommendation, with no current summary pointing to the
Birch decision appended at the end. Thus a returning reader still had to inspect
revision history to establish the current state. The subsequent skill/template
change asks for a current opening view and distinguishes it from preserved
history; it has not yet been verified in a new real model/user run.

Keep the observed skill-path lookup retries and Markdown/full-detail warning in
the run record. No TASK.md or associated feedback.json convention was used. These
results do not prove open investigation, comments with nonempty feedback,
concurrent editing, crash recovery, permissions/notification failures or final
release UX. No complete Research acceptance box is checked by this run.

After both turns completed, the original daily service was restored, its
configuration/plist hashes matched and independent health passed. Candidate
processes exited; workspace files were archived with hashes and the owned root
was removed. The single test document is retained for review and follow-up
validation. No PR was merged by the agent.

## Current-overview retest

Integrated candidate `8954ab8b` included the overview guidance. A new full-document
comment corrected Birch's deployment cost to 2,600 while retaining offline
read/write and Cedar-stop requirements. A native chat message asked only to read
the latest document/comments and revise, without naming the stale overview or
repeating the corrected value. Actual rollout metadata confirmed Luna.

Document revision 10 begins with the R3 current state: Birch, 2,600, the 1,160
difference from Atlas, the comment marker and next steps. Detailed R3 findings
agree; the old 2,200 values, original sources and R2 user paragraph remain as
history. The final chat reply links the same document and reports those changes.
This supplies a scoped real behavior pass for the current-overview fix and a
nonempty comment, not a complete Research/lifecycle or visual-rendering pass.

The run also exposed a separate receipt problem: Feishu inserts a blank line
before an appended Markdown heading and removes its terminal newline. Strict
receipt matching rejected it; the agent reconciled then appended a second
receipt before continuing. Preserve this failure, including the redundant
receipt, rather than count feedback acknowledgement as cleanly passed.

Two UI calls, no screenshots. The original service was restored and independently
healthy; configuration/plist hashes matched. Owned workspace and model-created
temporary files were archived with hashes then removed after ownership and
process checks. The one research document remains available for follow-up.
