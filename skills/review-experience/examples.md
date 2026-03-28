# Review Experience Examples

## Example 1: Code Change Review

**Scenario**: Agent fixed a bug and wants the user to review before committing.

```
# Step 1: Create review space
create_chat({ name: "Review: Fix login timeout bug" })
# Returns: { chatId: "oc_review_abc123" }

# Step 2: Register lifecycle
register_temp_chat({
  chatId: "oc_review_abc123",
  expiresAt: "2026-03-28T14:00:00.000Z",  // 2 hours from now
  creatorChatId: "oc_original_chat",
  context: {
    type: "review",
    task: "Fix login timeout bug",
    status: "pending_decision"
  }
})

# Step 3: Present summary
send_text({
  chatId: "oc_review_abc123",
  text: "# Bug Fix: Login Timeout\n\n## Problem\nUsers experienced 30s timeout when logging in with expired tokens.\n\n## Solution\nAdded token refresh logic before auth attempt. Falls back to re-login if refresh fails.\n\n## Files Changed\n- `src/auth/login.ts` — Added `refreshToken()` call before `authenticate()`\n- `src/auth/login.test.ts` — Added 3 test cases for token refresh scenarios\n\n## Testing\n- All 42 existing tests pass\n- 3 new tests for token refresh: success, failure, concurrent\n- Manual testing: verified with expired token"
})

# Step 4: Request decision
send_interactive({
  chatId: "oc_review_abc123",
  title: "Code Review",
  question: "## Summary\nFixed login timeout by adding token refresh before authentication.\n\n## Changes\n- Added `refreshToken()` call in login flow\n- Token refresh fallback to re-login\n- 3 new test cases\n\n## Testing\n42/42 tests passing, 3 new tests added.\n\nPlease review and decide:",
  options: [
    { text: "Merge", value: "approve", type: "primary" },
    { text: "Need Changes", value: "request_changes", type: "default" },
    { text: "Discard", value: "reject", type: "danger" }
  ],
  actionPrompts: {
    "approve": "[User Decision] User approved the login timeout fix. Proceed with committing the changes.",
    "request_changes": "[User Decision] User requested changes to the login timeout fix. Ask what changes they want.",
    "reject": "[User Decision] User rejected the login timeout fix. Ask for the reason."
  }
})
```

## Example 2: Document Review

**Scenario**: Agent drafted a technical design document.

```
# Step 1-2: Create and register (same pattern)
create_chat({ name: "Review: API v2 Design Doc" })
# chatId: "oc_review_doc456"

register_temp_chat({
  chatId: "oc_review_doc456",
  expiresAt: "2026-03-28T16:00:00.000Z",  // 4 hours for document review
  creatorChatId: "oc_original_chat",
  context: { type: "review", task: "API v2 Design Document", status: "pending_decision" }
})

# Step 3: Present document summary
send_text({
  chatId: "oc_review_doc456",
  text: "# API v2 Design Document\n\n## Overview\nProposed REST API v2 with breaking changes for improved consistency.\n\n## Key Decisions\n1. **Pagination**: Cursor-based (replaces offset-based)\n2. **Auth**: Bearer tokens only (drop API key support)\n3. **Response format**: Envelope `{ data, meta, errors }`\n\n## Breaking Changes\n- `/v1/users` -> `/v2/users`\n- Offset pagination removed\n- API key auth removed\n\n## Migration Plan\n- 6-month deprecation window for v1\n- Auto-redirect for common endpoints\n- Migration guide for API consumers"
})

# Step 4: Send document file + decision card
send_file({ chatId: "oc_review_doc456", filePath: "/path/to/api-v2-design.md" })

send_interactive({
  chatId: "oc_review_doc456",
  title: "Document Review",
  question: "## API v2 Design Document\n\n### Key Points\n- Cursor-based pagination\n- Bearer token auth only\n- Standardized response envelope\n- 6-month v1 deprecation\n\n### Open Questions\n- Should we support GraphQL as an alternative?\n- Deprecation timeline: 6 months or 3 months?\n\nPlease review and decide:",
  options: [
    { text: "Approve", value: "approve", type: "primary" },
    { text: "Revise", value: "request_changes", type: "default" },
    { text: "Need Discussion", value: "reject", type: "default" }
  ],
  actionPrompts: {
    "approve": "[User Decision] User approved the API v2 design document. Proceed with implementation planning.",
    "request_changes": "[User Decision] User wants revisions to the API v2 design. Ask what to change.",
    "reject": "[User Decision] User wants to discuss the API v2 design further. Start a discussion."
  }
})
```

## Example 3: Multi-Option Decision

**Scenario**: Agent researched database options and needs the user to choose.

```
# Step 1-2: Create and register
create_chat({ name: "Decision: Database Selection" })

register_temp_chat({
  chatId: "oc_review_db789",
  expiresAt: "2026-03-28T14:00:00.000Z",
  creatorChatId: "oc_original_chat",
  context: { type: "review", task: "Database technology selection", status: "pending_decision" }
})

# Step 3: Present options
send_text({
  chatId: "oc_review_db789",
  text: "# Database Technology Decision\n\n## Requirements\n- Handle 10K concurrent connections\n- Sub-10ms read latency\n- Support complex aggregations\n- Team experience: PostgreSQL (high), MongoDB (medium)\n\n## Option A: PostgreSQL + Citus\n- Pros: Team expertise, ACID, sharding via Citus\n- Cons: Complex setup, vertical scaling limits\n- Cost: ~$500/month (3 nodes)\n\n## Option B: MongoDB Atlas\n- Pros: Horizontal scaling built-in, flexible schema\n- Cons: Less team experience, eventual consistency concerns\n- Cost: ~$400/month (3-node cluster)\n\n## Option C: Stay with PostgreSQL (no sharding)\n- Pros: Zero migration cost, well-understood\n- Cons: May hit scaling limits at 50K users\n- Cost: ~$200/month (single node + replica)"
})

# Step 4: Decision card
send_interactive({
  chatId: "oc_review_db789",
  title: "Decision Required",
  question: "## Database Selection\n\n### Recommendation\n**Option A: PostgreSQL + Citus** — Best balance of team expertise and scalability.\n\n### Key Trade-off\nOption A costs more but reduces risk. Option C saves money but may need migration in 6 months.",
  options: [
    { text: "A: PostgreSQL + Citus", value: "option_a", type: "primary" },
    { text: "B: MongoDB Atlas", value: "option_b", type: "default" },
    { text: "C: Stay PostgreSQL", value: "option_c", type: "default" },
    { text: "Need More Data", value: "more_info", type: "default" }
  ],
  actionPrompts: {
    "option_a": "[User Decision] User chose PostgreSQL + Citus. Proceed with setup planning.",
    "option_b": "[User Decision] User chose MongoDB Atlas. Proceed with migration planning.",
    "option_c": "[User Decision] User chose to stay with PostgreSQL (no sharding). Document the scaling limit.",
    "more_info": "[User Decision] User needs more data to decide. Ask what additional information they need."
  }
})
```
