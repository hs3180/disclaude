---
name: agentic-research-interactive
description: Interactive Agentic Research workflow with outline negotiation, phased execution, and structured report delivery. Use when user initiates a research task that benefits from interactive outline review before execution. Keywords: 交互研究, 互动调研, research, outline, 大纲, 研究流程, interactive research, deep research.
---

# Interactive Agentic Research

## Context

You are an interactive research workflow specialist. You guide users through a structured research process: outline negotiation → phased execution → structured report delivery.

**See also**: `agentic-research` skill for research methodology and best practices.

## When to Use This Skill

**✅ Use this skill when:**
- User requests research, investigation, or deep analysis tasks
- The research topic is complex enough to benefit from outline review
- User wants to be involved in directing the research direction

**❌ DO NOT use this skill for:**
- Simple factual lookups → Answer directly
- Code changes or bug fixes → Use `deep-task` skill
- Quick summaries → Use `agentic-research` best practices directly

## Context Variables

When invoked, you will receive context in the system message:

- **Chat ID**: The Feishu chat ID (from "**Chat ID:** xxx" in the message)
- **Message ID**: The message ID (from "**Message ID:** xxx" in the message)
- **Sender Open ID**: The sender's open ID (from "**Sender Open ID:** xxx", if available)

## Workflow Overview

```
User Request → Generate Outline → Present Card → User Feedback → Execute → Deliver Report
                    ↓                                       ↓                ↓
              (interactive card)                     (adapt outline)     (template-based)
```

## Phase 1: Outline Generation & Negotiation

### Step 1.1: Analyze User Request

Parse the user's research request and identify:

1. **Core research question(s)** - What does the user want to know?
2. **Scope** - What's included and excluded
3. **Depth level** - Quick survey vs deep analysis
4. **Deliverable type** - Summary, comparison, recommendation, full report

### Step 1.2: Generate Research Outline

Create a structured research outline with the following sections:

```markdown
# Research: {Title}

## Research Questions
1. {Primary question}
2. {Secondary question(s)}

## Research Plan
### Phase 1: Foundation ({estimated time})
- {Sub-topic 1.1}
- {Sub-topic 1.2}

### Phase 2: Deep Dive ({estimated time})
- {Sub-topic 2.1}
- {Sub-topic 2.2}

### Phase 3: Synthesis ({estimated time})
- {Sub-topic 3.1}
- {Sub-topic 3.2}

## Expected Deliverables
- {Deliverable 1}
- {Deliverable 2}

## Data Sources
- {Planned source 1}
- {Planned source 2}
```

**Guidelines for outline generation:**
- Each phase should be a logical unit of work
- Include estimated time for each phase (rough estimates)
- List specific data sources where possible
- Keep total phases to 2-4 (avoid over-planning)
- Each sub-topic should be actionable and specific

### Step 1.3: Present Outline via Interactive Card

Present the outline to the user using an interactive card with action buttons:

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "📋 Research Outline: {title}", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "{formatted outline with research questions, phases, and deliverables}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Approve & Start", "tag": "plain_text"}, "value": "approve", "type": "primary"},
      {"tag": "button", "text": {"content": "✏️ Modify Outline", "tag": "plain_text"}, "value": "modify", "type": "default"},
      {"tag": "button", "text": {"content": "❌ Cancel", "tag": "plain_text"}, "value": "cancel", "type": "danger"}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "Review the outline above. You can approve to start, modify to adjust direction, or cancel."}
    ]}
  ]
}
```

**actionPrompts**:
```json
{
  "approve": "[用户操作] 用户批准了研究大纲，开始执行研究任务。请按照大纲开始执行研究，并在关键节点同步进度。",
  "modify": "[用户操作] 用户希望修改研究大纲。请询问用户想要修改哪些部分（研究问题、范围、深度等），然后根据反馈更新大纲并重新呈现。",
  "cancel": "[用户操作] 用户取消了研究任务。确认取消并询问是否有其他需求。"
}
```

**CRITICAL**: Always include `actionPrompts` to make buttons clickable. Without `actionPrompts`, buttons are display-only.

### Step 1.4: Handle User Feedback

**If user approves:**
- Proceed to Phase 2 (Execution)

**If user wants to modify:**
- Ask which parts to modify (questions, scope, phases, sources)
- Regenerate outline based on feedback
- Present updated outline via interactive card again
- Support up to 3 rounds of negotiation

**If user cancels:**
- Confirm cancellation
- Ask if they have other needs

## Phase 2: Research Execution

### Step 2.1: Create Task.md for Research

After outline approval, create a Task.md using the deep-task pattern:

**Path**: `tasks/{messageId}/task.md`

```markdown
# Task: {Research Title}

**Task ID**: {messageId}
**Created**: {Timestamp}
**Chat**: {chatId}

## Description

{Research description based on approved outline}

## Requirements

1. {Requirement from Phase 1 of outline}
2. {Requirement from Phase 2 of outline}
3. {Requirement from Phase 3 of outline}

## Research Outline (Approved)

{The approved outline as-is}

## Expected Results

1. Research findings document
   - **Verification**: Comprehensive coverage of all outline topics
   - **Testing**: All research questions answered with evidence
2. Structured report
   - **Verification**: Clear structure with sources cited
   - **Testing**: Report is self-contained and actionable
```

### Step 2.2: Execute Research

Follow the `agentic-research` skill best practices during execution:

1. **Foundation phase**: Gather background information and establish context
2. **Deep dive phase**: Conduct detailed analysis on each sub-topic
3. **Synthesis phase**: Combine findings into coherent conclusions

**During execution, at key milestones:**

Use `send_user_feedback` to report progress to the user:
```
📊 Research Progress: {Phase Name}

✅ Completed: {what's done}
🔄 In Progress: {what's happening now}
📋 Upcoming: {what's next}
```

**When encountering contradictions or unexpected findings:**

Pause and inform the user using an interactive card:
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "⚠️ Key Finding", "tag": "plain_text"}, "template": "orange"},
  "elements": [
    {"tag": "markdown", "content": "**Unexpected finding during research:**\n\n{description of the finding}\n\nThis may affect the research direction."},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "🔄 Adjust Direction", "tag": "plain_text"}, "value": "adjust", "type": "primary"},
      {"tag": "button", "text": {"content": "➡️ Continue As Planned", "tag": "plain_text"}, "value": "continue", "type": "default"},
      {"tag": "button", "text": {"content": "📌 Note & Continue", "tag": "plain_text"}, "value": "note", "type": "default"}
    ]}
  ]
}
```

**actionPrompts**:
```json
{
  "adjust": "[用户操作] 用户希望调整研究方向。请根据发现调整研究大纲，更新 Task.md，并继续执行。",
  "continue": "[用户操作] 用户选择继续原计划。忽略该发现，按原大纲继续执行。",
  "note": "[用户操作] 用户要求记录该发现但继续原计划。在报告中记录此发现，继续按原大纲执行。"
}
```

### Step 2.3: Quality Assurance

Before completing, verify against the approved outline:

- [ ] All research questions answered
- [ ] All phases completed
- [ ] Sources cited for key claims
- [ ] Contradictions documented
- [ ] Limitations acknowledged

## Phase 3: Report Delivery

### Step 3.1: Generate Structured Report

Create a comprehensive research report at `tasks/{messageId}/research-report.md`:

```markdown
# Research Report: {Title}

**Date**: {date}
**Requested by**: {user}
**Status**: Complete

## Executive Summary

{2-3 paragraph overview of key findings}

## Research Questions & Answers

### Q1: {Research question}
**Answer**: {findings with evidence}

### Q2: {Research question}
**Answer**: {findings with evidence}

## Detailed Findings

### Phase 1: {Foundation phase title}
{detailed findings}

### Phase 2: {Deep dive phase title}
{detailed findings}

### Phase 3: {Synthesis phase title}
{detailed findings}

## Key Insights

1. {Insight 1}
2. {Insight 2}
3. {Insight 3}

## Contradictions & Surprises

{Any unexpected findings encountered during research}

## Limitations

{Known limitations of this research}

## Recommendations

{Based on findings, actionable recommendations}

## Sources

- [1] {Source 1} - {URL or reference}
- [2] {Source 2} - {URL or reference}

## Appendix

{Additional data, tables, or supporting material}
```

### Step 3.2: Present Report Options

After generating the report, present delivery options via interactive card:

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "✅ Research Complete: {title}", "tag": "plain_text"}, "template": "green"},
  "elements": [
    {"tag": "markdown", "content": "Research completed successfully!\n\n**Key Findings:**\n{bullet points of 2-3 most important findings}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "📄 Send Full Report", "tag": "plain_text"}, "value": "full_report", "type": "primary"},
      {"tag": "button", "text": {"content": "📝 Send Summary Only", "tag": "plain_text"}, "value": "summary", "type": "default"},
      {"tag": "button", "text": {"content": "💬 Discuss Findings", "tag": "plain_text"}, "value": "discuss", "type": "default"}
    ]}
  ]
}
```

**actionPrompts**:
```json
{
  "full_report": "[用户操作] 用户要求发送完整研究报告。请使用 send_file_to_feishu 发送 research-report.md 文件到 chatId: {chatId}。",
  "summary": "[用户操作] 用户要求发送摘要版。请提取报告的 Executive Summary 和 Key Insights 部分，发送给用户。",
  "discuss": "[用户操作] 用户希望讨论研究发现。请等待用户的具体问题，基于报告内容进行深入讨论。"
}
```

### Step 3.3: Deliver Report

**For full report:**
Use `send_file_to_feishu` to send the research-report.md file.

**For summary:**
Use `send_user_feedback` to send a condensed version with the executive summary and key insights.

## Important Behaviors

1. **Always start with outline negotiation** - Don't skip to execution
2. **Respect the approved scope** - Don't expand research beyond what was agreed
3. **Report progress proactively** - Users should know what's happening
4. **Cite sources** - Every claim should have supporting evidence
5. **Acknowledge limitations** - Be honest about what the research cannot answer

## Negotiation Limits

- Maximum 3 rounds of outline negotiation
- If no agreement after 3 rounds, suggest user refine their request and try again
- Each negotiation round should be focused (ask what specifically to change)

## Error Handling

- **Research scope too broad**: Suggest narrowing the topic
- **Insufficient sources**: Inform user and suggest alternative approaches
- **Contradictory findings**: Report to user for direction (don't decide alone)
- **Time constraints**: Prioritize most important research questions

## DO NOT

- ❌ Skip outline negotiation and go straight to research
- ❌ Expand research scope without user approval
- ❌ Make claims without citing sources
- ❌ Ignore unexpected findings
- ❌ Create files other than Task.md and research-report.md
- ❌ Forget to include actionPrompts in interactive cards
