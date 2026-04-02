---
name: research-state
description: Maintain RESEARCH.md research state file during research sessions. Use when starting a research topic, discovering new findings, generating questions, or completing a research session. Keywords: 研究状态, RESEARCH.md, research state, research progress, 研究进度.
---

# Research State File Management

## Overview

This skill guides the maintenance of `RESEARCH.md` — a state file that tracks research progress within a research session. Similar to how `CLAUDE.md` provides project context, `RESEARCH.md` provides research session context.

## When to Use

- **Starting a new research topic**: Initialize RESEARCH.md with topic, goals, and background
- **After discovering new information**: Add findings to the findings section
- **When new questions arise**: Add questions to the pending section
- **When answering questions**: Mark questions as resolved
- **When finding useful resources**: Add resource links
- **Completing a research session**: Write a conclusion summary

## RESEARCH.md File Structure

```markdown
# {Research Topic Title}

> {Brief background description}

## 研究目标
- [ ] Goal 1
- [ ] Goal 2

## 已收集的信息
### Finding Title
- 来源：{source URL or document name}
- 关键内容：{key content summary}

## 待调查的问题
- [ ] Unresolved question 1
- [x] Resolved question 2

## 研究结论
{Conclusion summary when research is complete}

## 相关资源
- [Resource Name](URL)
```

## Maintenance Workflow

### Research Start

1. Create `RESEARCH.md` in the research working directory
2. Fill in the topic title (H1 heading)
3. Add a brief background description as a blockquote
4. List all research goals as checklist items under "研究目标"

### During Research

1. **Read** RESEARCH.md at the start of each interaction to restore context
2. **After each significant finding**:
   - Add a subsection under "已收集的信息"
   - Include source and key content
3. **When a new question arises**:
   - Add `- [ ] question text` under "待调查的问题"
4. **When a question is answered**:
   - Change `- [ ]` to `- [x]` for that question
5. **When finding useful resources**:
   - Add `- [Resource Name](URL)` under "相关资源"

### Research End

1. Write a comprehensive conclusion under "研究结论"
2. Ensure all questions are marked as resolved or noted as remaining
3. Verify all findings are documented with sources

## Best Practices

- **Be concise**: Each finding should be a brief summary, not a full analysis
- **Cite sources**: Always include the source URL or document reference
- **Stay factual**: Keep findings objective and evidence-based
- **Update promptly**: Don't batch updates — update after each interaction
- **Review regularly**: Re-read RESEARCH.md at session start for context continuity

## Related

- Issue #1710: RESEARCH.md research state file implementation
- Issue #1709: Research Mode (provides mode switching framework)
- `agentic-research` skill: General research best practices
