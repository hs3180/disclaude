---
name: review-experience
description: Imperial review experience guide. Use when the Agent has completed a task that requires user review or approval (code changes, document drafts, design decisions, PR reviews). Keywords: review, 审批, 批准, review, approve, 御书房, 奏折, 决策.
---

# Imperial Review Experience (御书房批奏折)

You have completed a task that requires user review and approval. This guide helps you deliver a seamless "imperial court memorial" (御书房批奏折) experience — where the user can review your work and make decisions with a single tap, just as an emperor reviews memorials in the imperial study.

## When to Trigger

Use this workflow when:
- You have completed code changes that need approval before merging/committing
- You have drafted a document or proposal that needs user sign-off
- You have made a design decision that requires user confirmation
- Any task where the user should see **what changed** and **decide what to do next**

## Core Principle

> **Imperial Review = Temporary Chat + Clear Presentation + One-Tap Decision**
>
> Use **existing MCP tools** to create an isolated review space. No custom tools needed.

## Available Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `create_chat` | Create a temporary review group | Step 1: Set up review space |
| `register_temp_chat` | Register lifecycle (auto-cleanup) | Step 2: Ensure cleanup |
| `send_text` | Present review content | Step 3: Show what you did |
| `send_file` | Send changed files | Step 3: Share artifacts |
| `send_interactive` | Send decision card | Step 4: Request decision |

## Workflow

### Step 1: Create Review Space

Create a dedicated temporary chat for the review:

```
create_chat({
  name: "Review: {brief topic}",
  description: "Review session for {task description}"
})
```

Capture the returned `chatId` for all subsequent messages.

### Step 2: Register Lifecycle

Register the chat for automatic cleanup when expired:

```
register_temp_chat({
  chatId: "{chatId from Step 1}",
  expiresAt: "{ISO timestamp, e.g., 2-4 hours from now}",
  creatorChatId: "{original chat ID where the task was requested}",
  context: {
    type: "review",
    task: "{brief task description}",
    status: "pending_decision"
  }
})
```

**Best practices:**
- Set expiration to 2-4 hours (not 24h default) — review decisions should be timely
- Always include `creatorChatId` so the original requester can be notified
- Include `context` for traceability

### Step 3: Present the Memorial (奏折)

This is the core of the imperial experience. Present your work clearly and completely so the user can make an informed decision **without** needing to scroll through chat history.

#### 3a: Send a Summary

Use `send_text` to provide a structured summary:

```
send_text({
  chatId: "{chatId}",
  text: "# {Task Title}\n\n## What I Did\n{clear description of changes}\n\n## Why\n{rationale for the approach}\n\n## Files Changed\n{list of modified files with brief descriptions}\n\n## Impact\n{potential effects, risks, or considerations}"
})
```

#### 3b: Send Artifacts (Optional)

If there are files the user should review:

```
send_file({
  chatId: "{chatId}",
  filePath: "{path to file}"
})
```

Use this for:
- Diff files or patches
- Configuration files
- Generated documents
- Log excerpts

### Step 4: Request Decision (御笔朱批)

Send an interactive card with clear decision options:

```
send_interactive({
  chatId: "{chatId}",
  title: "Awaiting Your Decision",
  question: "Please review the above and make a decision:",
  options: [
    { text: "Approve", value: "approve", type: "primary" },
    { text: "Request Changes", value: "request_changes", type: "default" },
    { text: "Reject", value: "reject", type: "danger" }
  ],
  actionPrompts: {
    "approve": "[User Decision] User approved the review for: {task}. Proceed with committing/merging.",
    "request_changes": "[User Decision] User requested changes for: {task}. Ask the user what changes they want.",
    "reject": "[User Decision] User rejected the review for: {task}. Ask for the reason and discuss alternatives."
  }
})
```

### Step 5: Handle Decision

When the user clicks a button, you will receive a message with the action prompt. Handle each decision:

| Decision | Your Response |
|----------|--------------|
| **Approve** | Execute the approved action (commit, merge, deploy, etc.) and confirm completion |
| **Request Changes** | Ask the user what specific changes they want, then implement them |
| **Reject** | Ask for the reason, discuss alternatives, and offer to revert if needed |

After handling the decision, update the temp chat status:

```
register_temp_chat({
  chatId: "{chatId}",
  context: {
    type: "review",
    task: "{task}",
    status: "completed",
    decision: "{approve|changes|reject}"
  }
})
```

## Review Card Templates

### For Code Changes

```
send_interactive({
  chatId: "{chatId}",
  title: "Code Review",
  question: "## Summary\n{1-2 sentence summary of changes}\n\n## Changes\n{bullet list of key changes}\n\n## Testing\n{how changes were verified}\n\nPlease review and decide:",
  options: [
    { text: "Merge", value: "approve", type: "primary" },
    { text: "Need Changes", value: "request_changes", type: "default" },
    { text: "Discard", value: "reject", type: "danger" }
  ]
})
```

### For Document/Proposal Review

```
send_interactive({
  chatId: "{chatId}",
  title: "Document Review",
  question: "## Document: {title}\n\n### Key Points\n{bullet list of main points}\n\n### Open Questions\n{any items needing user input}\n\nPlease review and decide:",
  options: [
    { text: "Looks Good", value: "approve", type: "primary" },
    { text: "Revise", value: "request_changes", type: "default" },
    { text: "Start Over", value: "reject", type: "danger" }
  ]
})
```

### For Multi-Option Decisions

When the user needs to choose between alternatives:

```
send_interactive({
  chatId: "{chatId}",
  title: "Decision Required",
  question: "## {Decision Topic}\n\n### Option A: {name}\n{description}\n\n### Option B: {name}\n{description}\n\n### Recommendation\n{your recommendation with reasoning}",
  options: [
    { text: "Option A: {name}", value: "option_a", type: "primary" },
    { text: "Option B: {name}", value: "option_b", type: "default" },
    { text: "Need More Info", value: "more_info", type: "default" }
  ]
})
```

## Quality Checklist

Before sending the review card, verify:

- [ ] The summary clearly explains **what** was done and **why**
- [ ] All changed files are listed with brief descriptions
- [ ] The decision options are clear and mutually exclusive
- [ ] The action prompts correctly describe what happens for each option
- [ ] The temp chat has a reasonable expiration time
- [ ] The `creatorChatId` is set for traceability

## Anti-Patterns (Learned from History)

### Do NOT Create New MCP Tools

Historical attempts to create `request_review`, `review-card-builder`, or `ask_user` tools were all rejected. The existing tool combination is sufficient:

```
create_chat + register_temp_chat + send_text + send_interactive = Complete review experience
```

### Do NOT Over-Engineer the Card

- Use `send_interactive` with simple `question` + `options`
- Do NOT build custom card JSON templates
- Do NOT create specialized card builders
- The Primary Node handles card rendering automatically

### Do NOT Block Waiting for Response

- Send the review card and stop
- When the user clicks a button, you will receive a new message
- Handle the decision in that new conversation turn

### Do NOT Forget Lifecycle Management

- Always call `register_temp_chat` to ensure cleanup
- Set a reasonable expiration (2-4 hours for reviews)
- Include context data for traceability

## Chat ID Handling

The Chat ID is provided in the context. Look for:

```
**Chat ID:** `oc_xxx`
```

Use the **original** chat ID as `creatorChatId` when registering the temp chat. The review chat will have its own chat ID returned by `create_chat`.

## Related

- Issue #946: Original feature request for imperial review experience
- Issue #1703: Temporary chat lifecycle management (infrastructure)
- Issue #1294: Removal of over-engineered review-card-builder
- Issue #1298: Removal of start_group_discussion tool
