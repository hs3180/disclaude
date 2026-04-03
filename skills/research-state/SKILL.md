---
name: research-state
description: RESEARCH.md research state file lifecycle management - initialize, update, and archive research progress tracking files. Use when user mentions "research state", "RESEARCH.md", "研究状态", "研究进度", "归档研究", or when the agent is in research mode and needs to create or update a RESEARCH.md file. Also triggered when continuing or resuming a research session.
---

# Research State — RESEARCH.md Lifecycle Management

## Overview

This skill manages the **RESEARCH.md** state file that tracks research progress, findings, and conclusions throughout a research session. It provides structured templates and update procedures for the complete research lifecycle.

## Relationship to Research Mode

| Skill | Responsibility |
|-------|---------------|
| `research-mode` | Mode switching, workspace isolation, SOUL loading |
| `research-state` (this skill) | RESEARCH.md creation, updates, finalization, archiving |

This skill can be used independently but is designed to work seamlessly with the `research-mode` skill. When used together:
- `research-mode` handles entering/exiting research mode and setting up the workspace
- `research-state` manages the RESEARCH.md file within that workspace

## Single Responsibility

- ✅ Create RESEARCH.md files with structured templates
- ✅ Define update procedures for research progress tracking
- ✅ Provide finalization and archiving workflows
- ✅ Support resuming existing research sessions
- ❌ Mode switching (handled by `research-mode`)
- ❌ SOUL loading (handled by `research-mode`)
- ❌ Research methodology (handled by `agentic-research`)

## Phase 1: File Initialization

### When to Initialize

- When entering research mode and the RESEARCH.md file doesn't exist yet
- When starting a new research topic in `workspace/research/{topic}/`
- When user explicitly requests creating a research state file

### Template

Create `RESEARCH.md` in the research directory (`workspace/research/{topic}/RESEARCH.md`) with this structure:

```markdown
# Research: {Topic Title}

> {Brief description of research goals and background}

**Status**: Active
**Started**: {YYYY-MM-DD}
**Last Updated**: {YYYY-MM-DD}

## Research Objectives
- [ ] {Primary objective from user request}
- [ ] {Secondary objective if applicable}

## Findings

### {Finding Title}
- **Source**: {URL or reference}
- **Date**: {YYYY-MM-DD}
- **Key Content**:
  - {Finding detail 1}
  - {Finding detail 2}
- **Relevance**: {How this relates to research objectives}
- **Confidence**: High / Medium / Low

## Questions to Investigate
- [ ] {Question arising from current findings}
- [ ] {Gap identified in current knowledge}

## Research Conclusions

(To be filled when research is complete)

## Related Resources
- [{Resource name}]({URL})
```

### Initialization Procedure

1. **Create the research directory** if it doesn't exist:
   ```bash
   mkdir -p workspace/research/{topic-slug}
   ```

2. **Create RESEARCH.md** using the template above, filling in:
   - `{Topic Title}`: The research topic (human-readable)
   - `{Brief description}`: One or two sentences explaining the research purpose
   - `{Primary objective}`: The main goal from the user's request
   - Any secondary objectives or sub-questions

3. **Confirm initialization** to the user:
   ```
   RESEARCH.md initialized in workspace/research/{topic-slug}/
   - Topic: {title}
   - Objectives: {count} items
   - Status: Active
   ```

## Phase 2: Auto-Update

### Update Triggers

Update RESEARCH.md **after each significant research interaction**, including:
- After gathering new information from any source
- After completing a search or data collection step
- After analyzing or synthesizing findings
- After answering a research question
- After identifying new questions or gaps
- When the user provides new direction or constraints

### Update Procedure

#### Adding a New Finding

When new information is discovered, add it under the `## Findings` section:

```markdown
### {Concise Finding Title}
- **Source**: {URL or reference}
- **Date**: {YYYY-MM-DD}
- **Key Content**:
  - {Key point 1}
  - {Key point 2}
- **Relevance**: {Connection to research objectives}
- **Confidence**: High / Medium / Low
```

**Rules for findings**:
- Use a descriptive, concise title that summarizes the finding
- Always include the source (URL, document name, or method of discovery)
- Rate confidence based on source reliability and corroboration
- Keep entries focused — one main idea per finding

#### Moving from Questions to Findings

When a question from `## Questions to Investigate` is answered:
1. Remove the `- [ ]` checkbox item from the Questions section
2. Add the answer as a new entry under `## Findings`
3. If the finding raises new questions, add those to the Questions section

#### Updating Metadata

After every update, refresh the metadata line:
- Update `**Last Updated**: {YYYY-MM-DD}` to today's date
- If all objectives are met, update `**Status**: Active` to `**Status**: Review`

#### Checking Objective Completion

After each update, review the `## Research Objectives` checklist:
- If an objective is fully addressed, mark it `- [x]`
- If an objective needs refinement based on new information, update the text

### Update Pattern

Use this pattern for consistent updates:

```
1. Read current RESEARCH.md
2. Determine what changed (new finding / question answered / new question)
3. Add new content to the appropriate section
4. Update metadata (Last Updated, Status, Objectives)
5. Write the updated RESEARCH.md
```

## Phase 3: Finalization and Archiving

### When to Finalize

- When all research objectives are met
- When the user explicitly says the research is complete
- When the user wants to pause and archive progress

### Finalization Procedure

1. **Update Status** to `Completed` or `Paused`:
   ```markdown
   **Status**: Completed  (or Paused)
   **Completed**: {YYYY-MM-DD}  (only if Completed)
   ```

2. **Write Research Conclusions** under `## Research Conclusions`:

```markdown
## Research Conclusions

### Summary
{2-3 sentence high-level summary of the research outcome}

### Key Findings
1. **{Finding 1}**: {Brief description and significance}
2. **{Finding 2}**: {Brief description and significance}
3. **{Finding 3}**: {Brief description and significance}

### Unresolved Questions
- {Question that remains unanswered}
- {Area requiring further investigation}

### Recommendations
- {Actionable recommendation based on findings}
```

3. **Verify completeness**:
   - [ ] All objectives checked off or explicitly noted as out-of-scope
   - [ ] All findings include sources
   - [ ] Conclusions section is filled
   - [ ] Unresolved questions are listed

### Archiving (Optional)

When research is completed and the user wants to archive:

```bash
# Move to archive directory
mkdir -p workspace/research/_archive
mv workspace/research/{topic-slug} workspace/research/_archive/{topic-slug}-{YYYY-MM-DD}
```

The archived directory retains the full RESEARCH.md and any supporting files for future reference.

### Report to User

After finalization, provide a summary:

```
Research completed: "{topic}"

Duration: {start date} → {end date}
Findings: {count} entries
Objectives met: {count}/{total}
Unresolved questions: {count}

Files:
- RESEARCH.md: workspace/research/{topic-slug}/RESEARCH.md
{If archived: - Archived to: workspace/research/_archive/{topic-slug}-{date}/}
```

## Resuming Research

### Detecting Existing Research

When the user mentions continuing or resuming research:

1. Check for existing RESEARCH.md files:
   ```bash
   find workspace/research -name "RESEARCH.md" -not -path "*/_archive/*"
   ```

2. If found, read the file to understand:
   - Current status (Active / Paused / Completed)
   - Research objectives and their completion state
   - Existing findings and sources
   - Outstanding questions

3. If multiple research directories exist, present options:
   ```
   Found {count} active research sessions:
   1. "{topic-1}" (Last updated: {date}, Status: {status})
   2. "{topic-2}" (Last updated: {date}, Status: {status})

   Which research session would you like to continue?
   ```

4. If none found, treat as a new research session and proceed to Phase 1.

### Resume Procedure

After identifying the correct research directory:

1. Read the current RESEARCH.md
2. Update `**Status**` to `Active` (if it was `Paused`)
3. Update `**Last Updated**` to today's date
4. Briefly summarize the current state to the user:
   ```
   Resuming research: "{topic}"
   - Objectives: {completed}/{total} completed
   - Findings so far: {count}
   - Outstanding questions: {count}
   ```
5. Continue from where the research left off

## DO NOT

- ❌ Create RESEARCH.md outside of a `workspace/research/` directory
- ❌ Delete or overwrite existing findings without user confirmation
- ❌ Mark objectives as complete without evidence in the Findings section
- ❌ Fabricate sources or confidence ratings
- ❌ Update RESEARCH.md for trivial interactions (e.g., greetings, clarifications)
- ❌ Use RESEARCH.md for non-research tasks

## Related

- Issue #1710: RESEARCH.md research state file (this skill)
- Issue #1709: Research mode (complementary — mode switching)
- Issue #1707: Original parent issue (split into #1709 + #1710)
