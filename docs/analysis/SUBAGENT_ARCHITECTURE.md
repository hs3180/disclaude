# Claude Agent SDK Subagent Architecture - Implementation Guide

## Overview

This document explains the proper implementation of custom subagents in the Claude Agent SDK, as applied to the Disclaude project for the web-extractor subagent.

## Key Concepts

### 1. Subagent Definition Location

**❌ WRONG**: Subagents are NOT defined in `.claude/agents/` directory
**✅ CORRECT**: Subagents are defined programmatically in the `agents` option when creating SDK queries

### 2. Subagent Type System

The `subagent_type` parameter in the Task tool is a string that references agent names defined in the `agents` Record.

```typescript
// Define agents when creating SDK query
const result = query({
  prompt: "Research AI in healthcare",
  options: {
    agents: {
      'web-extractor': { /* agent definition */ },
      'research-orchestrator': { /* agent definition */ }
    }
  }
});

// Later, invoke via Task tool
Task tool: {
  subagent_type: "web-extractor", // Must match key in agents Record
  prompt: "Extract from example.com..."
}
```

### 3. Skills vs Subagents

| Aspect | Skills | Subagents |
|--------|--------|-----------|
| **Location** | `.claude/skills/*/SKILL.md` | `agents` option in SDK query |
| **Invocation** | User: `/skill-name` | Agent: `Task tool` with `subagent_type` |
| **Purpose** | User-facing workflows | Agent delegation & parallelization |
| **Tool Access** | `allowed-tools` in frontmatter | `tools`/`disallowedTools` in AgentDefinition |
| **Context** | Inherits main agent context | Isolated context window |
| **Best For** | Reusable user commands | Parallel processing, specialists |

## Implementation in Disclaude

### Architecture Overview

```
User Request: "deep search AI in healthcare 2024"
    ↓
deep-search Skill (Orchestrator)
    ├── Stage 1: Generate keywords (no tools)
    ├── Stage 2: WebSearch API discovery (uses WebSearch tool)
    └── Stage 3: Delegate to web-extractor subagents
            ├── Task tool → web-extractor subagent (domain 1)
            ├── Task tool → web-extractor subagent (domain 2)
            └── Task tool → web-extractor subagent (domain 3)
                    ↓
                Each subagent:
                - Uses Playwright browser tools
                - Extracts structured information
                - Returns markdown results
                    ↓
            Orchestrator aggregates results
                ↓
            Final comprehensive report
```

### Code Structure

#### 1. Agent Client (`src/agent/client.ts`)

```typescript
private createSdkOptions(resume?: string) {
  const sdkOptions: Record<string, unknown> = {
    cwd: process.cwd(),
    permissionMode: this.permissionMode || 'default',
    settingSources: ['project'],
    allowedTools: [
      'Skill',
      'WebSearch',
      'Task',
      // ... Playwright tools
    ],

    // CUSTOM SUBAGENTS DEFINITION
    agents: {
      'web-extractor': {
        description: 'Specialized subagent for extracting comprehensive information from specific websites using Playwright browser automation',
        prompt: `You are a web extraction specialist...

## Extraction Process
1. Understand the Request
2. Navigate and Explore
3. Extract Core Content
4. Follow Related Links
5. Structure Findings

## Output Format
# Web Extraction Results: [Domain/URL]
...
`,
        tools: [
          'mcp__playwright__browser_navigate',
          'mcp__playwright__browser_click',
          'mcp__playwright__browser_snapshot',
          // ... all Playwright tools
        ],
        model: 'haiku', // Use faster model for extraction
        maxTurns: 15, // Allow thorough exploration
      },
    },

    mcpServers: {
      playwright: {
        type: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest'],
      },
    },
  };

  return sdkOptions;
}
```

**Key Points:**
- `agents` is a Record<string, AgentDefinition>
- Each agent has a unique key (e.g., 'web-extractor')
- Agent definition includes: description, prompt, tools, model, maxTurns
- The agent's prompt defines its behavior and output format

#### 2. Deep Search Skill (`.claude/skills/deep-search/SKILL.md`)

```yaml
---
name: deep-search
description: Conduct systematic multi-stage research...
allowed-tools: WebSearch,Task
---

# Deep Search

## Stage 3: Subagent Delegation

For each selected vertical domain from Stage 2, delegate to the **web-extractor subagent**:

**2. Use Task tool to delegate** - Call the web-extractor subagent:
```
Task tool parameters:
- subagent_type: "web-extractor" (custom subagent with Playwright tools)
- prompt: "Extract detailed information from [URL/domain]..."
- description: "Extract from [domain]"
```
```

**Key Points:**
- The skill is the orchestrator that coordinates research
- It uses Task tool to delegate to custom subagent
- `subagent_type: "web-extractor"` matches the key in agents Record
- The skill processes and aggregates subagent results

#### 3. Web Extractor Skill (`.claude/skills/web-extractor/SKILL.md`)

This skill is now **optional** since the subagent has its own prompt, but it can serve as:
- Documentation for the subagent's capabilities
- A user-invokable version for direct web extraction tasks
- Reference for proper extraction patterns

## AgentDefinition Type Reference

```typescript
type AgentDefinition = {
  /**
   * Natural language description of when to use this agent
   */
  description: string;

  /**
   * The agent's system prompt
   */
  prompt: string;

  /**
   * Array of allowed tool names. If omitted, inherits all tools from parent
   */
  tools?: string[];

  /**
   * Array of tool names to explicitly disallow for this agent
   */
  disallowedTools?: string[];

  /**
   * Model to use for this agent. If omitted or 'inherit', uses the main model
   */
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';

  /**
   * Maximum number of agentic turns (API round-trips) before stopping
   */
  maxTurns?: number;

  /**
   * Array of skill names to preload into the agent context
   */
  skills?: string[];

  /**
   * MCP servers configuration for this agent
   */
  mcpServers?: AgentMcpServerSpec[];

  /**
   * Experimental: Critical reminder added to system prompt
   */
  criticalSystemReminder_EXPERIMENTAL?: string;
};
```

## Best Practices

### 1. Subagent Design Principles

**Single Responsibility**
- Each subagent should have one clear purpose
- web-extractor only extracts information from websites
- Don't mix unrelated capabilities in one subagent

**Tool Restriction**
- Use `tools` array to grant only necessary tools
- Prevents subagent from performing unintended actions
- Improves security and predictability

**Model Selection**
- Use `haiku` for fast, simple tasks (extraction)
- Use `sonnet` for reasoning-heavy tasks (orchestration)
- Use `opus` for complex analysis (if needed)

**Turn Limits**
- Set `maxTurns` to prevent infinite loops
- Typical values: 5-15 for extraction tasks
- Adjust based on task complexity

### 2. Subagent Prompt Design

**Clear Instructions**
```typescript
prompt: `You are a web extraction specialist.

## Extraction Process
1. Understand the Request
2. Navigate and Explore
3. Extract Core Content
4. Follow Related Links
5. Structure Findings

## Output Format
Always return findings in this format:
# Web Extraction Results: [Domain/URL]
...
`
```

**Structured Output**
- Define exact output format in prompt
- Use markdown for structure
- Include required metadata (URL, date, etc.)

**Error Handling**
```typescript
prompt: `...
## Handling Challenges

### Paywalls and Login Requirements
- Note the restriction in findings
- Look for publicly available previews
- Clearly indicate what content is inaccessible

### Dynamic Content
- Wait for page to fully load before extracting
- Use browser_wait_for or snapshot to confirm load
- Note if essential content doesn't load
...
`
```

### 3. Orchestrator Pattern

**Delegation Strategy**
```markdown
#### Subagent Delegation Process

For each selected vertical domain from Stage 2, delegate to the **web-extractor subagent** using the Task tool:

**1. Prepare delegation request**
- Specify the target URL or domain
- Define extraction objectives
- Set depth parameters
- Specify content types of interest

**2. Use Task tool to delegate**
- subagent_type: "web-extractor"
- prompt: "Extract detailed information from [URL/domain]..."
- description: "Extract from [domain]"

**3. Process subagent results**
- Extract key findings from response
- Identify important statistics, quotes, insights
- Assess quality and depth of information

**4. Aggregate findings**
- Group by research dimension
- Cross-reference insights across domains
- Track data sources for citation
```

**Progress Tracking**
```markdown
**MANDATORY: Progress Updates (MUST EXECUTE)**

Before delegating to subagent for each domain, output:
```markdown
[深度搜集] 域名 X/Total
📍 目标: [Domain Name/URL]
🎯 目的: [what information to collect]
🤖 委派: web-extractor subagent
⏰ 预计时间: [X minutes]
```

After subagent completes each domain, output:
```markdown
[搜集完成] [Domain Name]
✅ 提取关键信息:
  - 📄 核心论文/文章: X 篇
  - 📊 关键数据点: X 个
  - 💡 重要洞察: X 条
📊 总体进度: X/Total 域名 (Z%)
```
```

### 4. Context Isolation Benefits

**Why Use Subagents?**

1. **Parallel Processing**
   - Multiple subagents can work simultaneously
   - Reduces total execution time
   - Each subagent has independent context

2. **Context Management**
   - Subagents use isolated context windows
   - Only send relevant information back to orchestrator
   - Prevents context overflow in main agent

3. **Specialization**
   - Each subagent is optimized for its task
   - Tools and model can be tailored
   - Prompts are focused and specific

4. **Error Isolation**
   - Failure in one subagent doesn't affect others
   - Easier to debug and retry specific tasks
   - Better error handling and recovery

## Common Patterns

### Pattern 1: Orchestrator-Worker (Used in deep-search)

```
Orchestrator Agent (deep-search)
├── Stage 1: Generate keywords (no tools)
├── Stage 2: WebSearch API (uses WebSearch tool)
└── Stage 3: Delegate to workers
    ├── Web Extractor (domain 1)
    ├── Web Extractor (domain 2)
    └── Web Extractor (domain 3)
```

**Characteristics:**
- Orchestrator: High-level planning (WebSearch, Task tools)
- Workers: Specialized tools (Playwright browser tools)
- Parallel execution via multiple Task tool calls
- Workers return structured results to orchestrator

### Pattern 2: Specialist Subagents by Capability

```typescript
agents: {
  'file-analyzer': {
    description: 'Analyzes file structure and content',
    tools: ['Read', 'Glob', 'Grep'],
    disallowedTools: ['Edit', 'Write'], // Read-only
    model: 'haiku',
  },
  'code-modifier': {
    description: 'Makes code changes',
    tools: ['Read', 'Edit', 'Bash(npm run lint:*)'],
    model: 'sonnet',
  },
  'test-runner': {
    description: 'Runs tests and reports results',
    tools: ['Bash(npm test:*)', 'Read'],
    model: 'haiku',
    maxTurns: 5,
  }
}
```

### Pattern 3: Context-Isolated Processing

```typescript
agents: {
  'log-searcher': {
    description: 'Searches through large log files for specific patterns',
    prompt: 'Search through log files and return ONLY relevant excerpts with line numbers...',
    tools: ['Bash(grep:*)', 'Read'],
    model: 'haiku',
    maxTurns: 3, // Don't get stuck in loops
  }
}
```

**Use Case**: Searching through large datasets where sending full context would be expensive.

## Testing and Verification

### 1. Verify Subagent Registration

```bash
# Build the project
npm run build

# Check the compiled output includes agent definitions
grep -A 5 "agents:" dist/cli-entry.js
```

### 2. Test Subagent Invocation

```bash
# Test with CLI
disclaude --prompt "deep search AI in healthcare 2024"

# Expected behavior:
# - Stage 2 uses WebSearch API (fast)
# - Stage 3 delegates to web-extractor subagent
# - Subagent uses Playwright tools
# - Results are structured and aggregated
```

### 3. Monitor Subagent Execution

```typescript
// In your skill, add progress tracking
console.log('[DEBUG] Delegating to web-extractor subagent');
const result = await Task({
  subagent_type: "web-extractor",
  prompt: "Extract from example.com...",
  description: "Extract from example.com"
});
console.log('[DEBUG] Subagent returned:', result);
```

## Troubleshooting

### Issue: "Subagent not found"

**Cause**: `subagent_type` doesn't match any key in `agents` Record

**Solution**:
```typescript
// Check the key name in agents definition
agents: {
  'web-extractor': { ... }  // Must match exactly
}

// Use the same key in Task tool
Task tool: {
  subagent_type: "web-extractor"  // Exact match
}
```

### Issue: Subagent has no tools

**Cause**: Missing or incorrect `tools` array in AgentDefinition

**Solution**:
```typescript
agents: {
  'web-extractor': {
    tools: [
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_click',
      // ... all required tools
    ]
  }
}
```

### Issue: Subagent not following instructions

**Cause**: Unclear or incomplete prompt in AgentDefinition

**Solution**:
- Add clear step-by-step process
- Define exact output format
- Include examples and best practices
- Add error handling instructions

### Issue: Subagent timing out or looping

**Cause**: Missing or too high `maxTurns` limit

**Solution**:
```typescript
agents: {
  'web-extractor': {
    maxTurns: 15, // Set reasonable limit
  }
}
```

## Performance Optimization

### 1. Model Selection

```typescript
// Fast extraction tasks
agents: {
  'web-extractor': {
    model: 'haiku',  // Fastest, good for structured extraction
  }
}

// Complex reasoning
agents: {
  'research-orchestrator': {
    model: 'sonnet',  // Balanced speed and intelligence
  }
}

// Deep analysis (if needed)
agents: {
  'data-analyst': {
    model: 'opus',  // Most capable, slower
  }
}
```

### 2. Turn Limits

```typescript
// Simple tasks (5-7 turns)
agents: {
  'url-validator': { maxTurns: 5 }
}

// Medium tasks (10-15 turns)
agents: {
  'web-extractor': { maxTurns: 15 }
}

// Complex tasks (20-30 turns)
agents: {
  'research-orchestrator': { maxTurns: 30 }
}
```

### 3. Parallel Execution

```markdown
# In orchestrator skill

Instead of sequential delegation:
❌ For each domain: delegate → wait → repeat

Use parallel delegation:
✅ Delegate to all domains simultaneously → wait for all → aggregate

Example:
```
For domains 1-10:
  - Delegate to web-extractor subagent (parallel)
  - Collect results as they complete
  - Aggregate all findings at end
```
```

## Migration Guide

### From "general-purpose" to Custom Subagent

**Before (using general-purpose):**
```markdown
Task tool parameters:
- subagent_type: "general-purpose"
- prompt: "/web-extractor https://example.com"
```

**After (using custom subagent):**
```markdown
Task tool parameters:
- subagent_type: "web-extractor"
- prompt: "Extract information from https://example.com about pricing"
```

**Benefits:**
- No need to invoke skill syntax
- Subagent has specialized tools by default
- Faster model (haiku) for extraction
- Better context isolation
- More predictable behavior

## Summary

The proper way to implement subagents in Claude Agent SDK:

1. **Define subagents programmatically** in `agents` option when creating SDK query
2. **Use Task tool** with `subagent_type` matching the agent key
3. **Restrict tools** via `tools` array in AgentDefinition
4. **Set appropriate model** (haiku for fast tasks, sonnet for reasoning)
5. **Limit turns** with `maxTurns` to prevent infinite loops
6. **Design clear prompts** with process, output format, and error handling
7. **Use orchestrator pattern** for coordinating multiple subagents
8. **Leverage parallel execution** for independent tasks

This architecture provides better performance, security, and maintainability compared to using skills or general-purpose subagents for specialized tasks.
