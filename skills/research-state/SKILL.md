---
name: research-state
description: RESEARCH.md research state file management. Use when starting a research task, continuing research across sessions, or when user mentions maintaining research progress. Keywords: 研究状态, RESEARCH.md, research state, 研究进度, research progress, 研究文件, research file.
allowed-tools: [Read, Write, Bash, Glob, Grep]
---

# Research State File Manager

## Context

- Research Topic: {topic}
- Research Directory: {researchDir}
- RESEARCH.md Path: {researchDir}/RESEARCH.md

You are a research state management specialist. Your job is to create, maintain, and finalize RESEARCH.md files that track research progress across interactions.

## Single Responsibility

- Create and maintain RESEARCH.md research state files
- Track findings, questions, and conclusions in structured markdown
- Guide agents on proper research state lifecycle management
- DO NOT perform actual research (use agentic-research skill for methodology)
- DO NOT make core system changes

## When to Use This Skill

**Trigger this skill when:**
- Starting a new research task that will span multiple interactions
- User mentions: "研究状态", "RESEARCH.md", "research progress", "研究进度"
- Continuing a previous research session
- Agent needs to persist research findings for future reference

## RESEARCH.md File Specification

### File Location

```
workspace/research/{topic}/RESEARCH.md
```

The research directory should use a slugified version of the research topic.

### Template Structure

```markdown
# {研究主题}

> {简要描述研究的目标和背景}

## 研究目标
- [ ] 目标 1
- [ ] 目标 2

## 已收集的信息

### 发现 1
- 来源：{source}
- 关键内容：{content}

### 发现 2
- 来源：{source}
- 关键内容：{content}

## 待调查的问题
- [ ] 问题 1
- [ ] 问题 2

## 研究结论
（研究完成后填写）

## 相关资源
- [资源名称](链接)
```

## Lifecycle Management

### Phase 1: Initialization

When starting a new research task:

1. **Create the research directory**:
   ```bash
   mkdir -p workspace/research/{topic-slug}
   ```

2. **Generate RESEARCH.md** with the template above, filling in:
   - `研究主题`: The research topic from user input
   - `简要描述`: A one-sentence summary of the research goal
   - `研究目标`: Initial goals based on user requirements (as checklist items)

3. **Inform the user**: Let them know the research state file has been created and where it is located.

### Phase 2: Active Research Updates

During research, update RESEARCH.md after significant findings:

**Adding a new finding:**
- Add a new `### 发现 N` subsection under `## 已收集的信息`
- Include source and key content
- Keep entries concise — one paragraph per finding

**Adding a new question:**
- Add `- [ ] {question}` under `## 待调查的问题`

**Resolving a question:**
- Change `- [ ] {question}` to `- [x] {question} — {brief answer}`
- Optionally move resolved items to findings section

**Adding a resource:**
- Add `- [{name}]({url})` under `## 相关资源`

**Updating goals:**
- Mark completed goals: `- [ ]` → `- [x]`
- Add new goals as research evolves

### Phase 3: Finalization

When research is complete:

1. **Write conclusions** under `## 研究结论`:
   - Summarize key findings (3-5 bullet points)
   - State the answer to the original research question
   - Note any limitations or caveats

2. **Verify completeness**:
   - All goals checked off
   - All questions resolved
   - All findings documented
   - Sources cited

3. **Add completion timestamp** at the top:
   ```
   > Completed: {ISO timestamp}
   ```

## Updating Rules

### DO
- Update RESEARCH.md after every significant research step
- Keep findings concise and factual
- Always cite sources
- Use consistent formatting
- Check for existing RESEARCH.md before creating a new one

### DO NOT
- Delete previous findings (append, don't replace)
- Add speculation without evidence
- Overwrite the entire file — update specific sections
- Include raw data dumps — summarize instead
- Create duplicate entries

## Integration with Research Workflow

This skill complements the `agentic-research` skill:

| Skill | Responsibility |
|-------|---------------|
| `agentic-research` | Research methodology and best practices |
| `research-state` | State file creation and maintenance |

When both skills are active:
1. Use `research-state` to initialize RESEARCH.md at the start
2. Use `agentic-research` for research methodology during execution
3. Use `research-state` to update findings after each research step
4. Use `research-state` to finalize when research is complete

## Session Continuity

When resuming a previous research session:

1. **Locate existing RESEARCH.md**:
   ```bash
   find workspace/research -name "RESEARCH.md"
   ```

2. **Read the file** to restore context:
   - Review research goals and current status
   - Check pending questions
   - Note the last findings added

3. **Continue research** from where it left off:
   - Address unanswered questions first
   - Add new findings to existing sections
   - Update goal checklist

## Related

- Issue #1710: RESEARCH.md research state file specification
- Issue #1709: Research Mode framework (upstream dependency)
- agentic-research skill: Research methodology guide
