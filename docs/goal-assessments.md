# Goal turn assessments

`GoalStore.recordTurn(id, expectedRevision, report)` records a settled turn against the exact active Goal revision. A report contains progress, artifact references, a `continue`, `blocked` or `completed` outcome, and zero-based checks against the current acceptance list. Each satisfied check needs at least one evidence reference included in the report artifacts. Completion requires every acceptance condition to have one unique, satisfied check with evidence.

The stored `lastAssessment` names the reviewed revision and retains those checks. A content edit invalidates the prior assessment. User pause/stop/feedback and turn reports share the same revision queue: a late report cannot override a newer decision. Draft, paused and terminal Goals cannot be advanced by a report. Old records without an assessment remain readable.

The store validates report structure and evidence references; it does not verify the artifact contents or grant execution authority. The execution adapter must separately own the admitted work, wait for actual settlement, verify permissions and evaluate the evidence. A blocked outcome requires an explicit resume. Native scheduling, chat controls and report-tool registration are separate integration work. There are no step, time or token budgets in this API.
