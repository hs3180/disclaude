---
name: research-mode
description: Research mode management - switch to isolated research environment with dedicated SOUL, working directory, and skill subset. Use when user says "研究模式", "research mode", "进入研究", "start research", "切换研究模式", or wants to begin a focused research session. Keywords: 研究模式, research, 调研模式, 研究环境.
---

# Research Mode Skill

## Context

You are managing the Research Mode for a chat session. Research Mode provides an isolated research environment by switching three dimensions:

| Dimension | Normal Mode | Research Mode |
|-----------|------------|---------------|
| SOUL | Default SOUL.md | Research-specific SOUL |
| Working Directory | `workspace/` | `workspace/research/{topic}/` |
| Skill Focus | Full skill set | Research-relevant skills |

## Activation Flow

When the user activates research mode (e.g., `/research-mode <topic>` or "进入研究模式: <topic>"):

### Step 1: Validate Input
- Extract the research topic from the user's command
- If no topic is provided, ask the user to specify one
- Sanitize the topic name for directory use (lowercase, hyphens for spaces)

### Step 2: Prepare Research Directory
- Create the research working directory: `workspace/research/{topic}/`
- Create a `RESEARCH.md` file in the directory with initial template:
  ```markdown
  # Research: {topic}

  ## Goal
  <!-- Describe the research objective -->

  ## Findings
  <!-- Document findings here -->

  ## Open Questions
  <!-- Track questions that need further investigation -->

  ## Sources
  <!-- Cite all sources -->

  ---
  Created: {timestamp}
  ```

### Step 3: Notify the User
Send a confirmation card:
```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "🔬 Research Mode Activated", "tag": "plain_text"}, "template": "green"},
    "elements": [
      {"tag": "markdown", "content": "**Topic**: {topic}\n**Working Directory**: `workspace/research/{topic}/`\n\nResearch environment is ready. All subsequent interactions will use the research working directory and follow research guidelines.\n\nUse `/research-exit` to return to normal mode."},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "📝 Start Research", "tag": "plain_text"}, "value": "start-research", "type": "primary"},
        {"tag": "button", "text": {"content": "🚪 Exit Research Mode", "tag": "plain_text"}, "value": "exit-research"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "<chat_id>",
  "actionPrompts": {
    "start-research": "[用户操作] 用户点击了开始研究",
    "exit-research": "[用户操作] 用户选择了退出研究模式"
  }
}
```

## Deactivation Flow

When the user exits research mode (e.g., `/research-exit` or "退出研究模式"):

### Step 1: Summary
- Read the `RESEARCH.md` from the research directory
- Provide a brief summary of the research session
- Mention any open questions or unfinished work

### Step 2: Notify the User
Send a summary card:
```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "Research Mode Deactivated", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "Research session for **{topic}** has ended.\n\n**Working Directory**: `workspace/research/{topic}/`\n**Duration**: {duration}\n\nResearch notes are preserved in the working directory."},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "🔬 Re-enter Research", "tag": "plain_text"}, "value": "re-enter-research"},
        {"tag": "button", "text": {"content": "📊 View Research Summary", "tag": "plain_text"}, "value": "view-summary"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "<chat_id>",
  "actionPrompts": {
    "re-enter-research": "[用户操作] 用户选择重新进入研究模式",
    "view-summary": "[用户操作] 用户查看研究摘要"
  }
}
```

## Research Behavior Guidelines

While in research mode, follow these principles:

1. **Directory Isolation**: Only access files within `workspace/research/{topic}/`
2. **Systematic Approach**: Define scope, gather data, analyze, synthesize
3. **Source Citation**: Always cite sources for claims and data
4. **Progress Tracking**: Update RESEARCH.md as you make progress
5. **Structured Output**: Present findings in organized markdown format

## Error Handling

- If the research directory cannot be created, inform the user and suggest checking permissions
- If the topic name is invalid (empty or only special characters), ask for a valid topic
- If RESEARCH.md already exists, read it and continue from where the previous session left off

## Related

- Issue #1709: Research Mode (SOUL + cwd + Skill set switching)
- Issue #1710: RESEARCH.md research state file
- Issue #1339: Agentic Research interactive workflow
