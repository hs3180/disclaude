---
name: pr-scanner
description: PR scanning and notification specialist. Scans repository for open PRs and sends notifications to Feishu. Use for periodic PR monitoring and discussion facilitation.
allowed-tools: Bash, Read, send_user_feedback
---

# PR Scanner

Scan repository for open Pull Requests and send notifications.

## Purpose

This skill enables periodic PR monitoring:
1. Scan repository for open PRs
2. Get detailed PR information
3. Send formatted notifications to Feishu

## When to Use

- Periodic PR status checks
- PR review reminders
- New PR detection

## Workflow

### 1. Scan Open PRs

Use `gh` CLI to scan open PRs:

```bash
# Get all open PRs
gh pr list --repo <owner/repo> --state open --json number,title,author,createdAt,headRefName

# Get detailed PR info
gh pr view <number> --repo <owner/repo> --json title,body,author,additions,deletions,changedFiles,statusCheckRollup
```

### 2. Format PR Information

Create a formatted message with:
- PR number and title
- Author
- Files changed / additions / deletions
- CI status
- Link to PR

### 3. Send Notification

Use `send_user_feedback` to send the formatted message to the designated chatId.

## Output Format

```markdown
## PR #123: Fix authentication bug

**Author:** @username
**Status:** CI Passing
**Changes:** +50 -10 (5 files)

**Description:**
Brief description of the PR...

**Link:** https://github.com/owner/repo/pull/123
```

## Important Notes

- This skill does NOT create group chats (ChatManager not available yet)
- Notifications are sent to a pre-configured chatId
- For group discussion features, wait for ChatManager implementation

## Error Handling

- If `gh` CLI fails, report error and retry once
- If send_user_feedback fails, log error and report to system
- If no open PRs found, send "No open PRs" message

## Example Prompt for Schedule

```markdown
Scan the hs3180/disclaude repository for open PRs:
1. Use `gh pr list` to get all open PRs
2. For each PR, get detailed info with `gh pr view`
3. Format the PR information
4. Send a summary to the designated chatId using send_user_feedback
```
