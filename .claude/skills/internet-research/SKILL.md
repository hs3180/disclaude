---
name: internet-research
description: This skill should be used when the user asks to "research", "internet research", "web research", "investigate online", "look something up", or needs to gather information from the web. Follows a 3-step process: 1) create research outline, 2) browse and collect information, 3) summarize findings into a report. Restricts access to only Playwright browser tools.
version: 2.0.0
tools: [
  "mcp__playwright__browser_click",
  "mcp__playwright__browser_close",
  "mcp__playwright__browser_console_messages",
  "mcp__playwright__browser_drag",
  "mcp__playwright__browser_evaluate",
  "mcp__playwright__browser_file_upload",
  "mcp__playwright__browser_fill_form",
  "mcp__playwright__browser_handle_dialog",
  "mcp__playwright__browser_hover",
  "mcp__playwright__browser_install",
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_navigate_back",
  "mcp__playwright__browser_network_requests",
  "mcp__playwright__browser_press_key",
  "mcp__playwright__browser_resize",
  "mcp__playwright__browser_run_code",
  "mcp__playwright__browser_select_option",
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_tabs",
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_type",
  "mcp__playwright__browser_wait_for"
]
---

# Internet Research

Structured web research skill. Follow a disciplined 3-step process to gather and synthesize information from the internet.

## Tool Constraints

Only Playwright browser tools are available. You cannot:
- Read, write, or edit local files
- Run bash commands or scripts
- Use grep, glob, or other search tools
- Access MCP tools other than Playwright

All research findings must be synthesized and presented directly in the conversation.

## Research Process

### Step 1: Create Research Outline

Before browsing, establish the research framework:

1. **Clarify the research question** - What specific information is needed?
2. **Identify key topics** - Break down the question into 3-5 main areas
3. **Plan sources** - Determine what types of sources (news, academic, documentation, forums)
4. **Define scope** - What time period, regions, or depth level

Present the outline to the user before proceeding.

### Step 2: Browse and Collect Information

Systematically gather data from the web:

1. **Start with authoritative sources** - Official documentation, reputable news, academic sources
2. **Use multiple sources** - Cross-check facts across 3+ sources
3. **Follow relevant links** - Deep dive into valuable references
4. **Capture key details** - Take snapshots of important pages
5. **Track sources** - Note URLs, dates, and authors for attribution

**Browsing strategy:**
- Use search engines effectively with specific queries
- Navigate to primary sources when possible
- Open multiple tabs for parallel investigation
- Take screenshots of critical information

### Step 3: Summarize Research Report

Synthesize findings into a structured report:

```
# Research Report: [Topic]

## Executive Summary
[2-3 sentence overview of key findings]

## Key Findings
### [Topic Area 1]
- Finding with supporting details
- Source: [URL]

### [Topic Area 2]
- Finding with supporting details
- Source: [URL]

## Detailed Analysis
[Elaborate on important findings with context]

## Sources
1. [Source Name](URL) - Date accessed
2. [Source Name](URL) - Date accessed
```

## Research Best Practices

- **Verify claims** across multiple sources before including as fact
- **Note publication dates** - information may be outdated
- **Distinguish fact from opinion** - attribute perspectives appropriately
- **Acknowledge limitations** - if information is incomplete, say so
- **Stay focused** - avoid going down unrelated tangents

## Usage

Activate by asking to "research [topic]", "investigate [topic]", or "look up [topic]". The skill will guide you through the 3-step process.
