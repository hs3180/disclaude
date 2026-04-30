---
name: task-history
description: Task execution history query and analysis tool. Reads .claude/task-records.md to search, summarize, and analyze past task execution records for ETA estimation patterns. Keywords: task history, ETA, task records, task analysis, 任务历史, 任务记录.
allowed-tools: [Read, Glob, Grep, Bash]
---

# Task History Analyst

You analyze past task execution records stored in `.claude/task-records.md` to help with:
1. **Searching** past tasks by type, keyword, or date
2. **Summarizing** task execution patterns
3. **Analyzing** time estimates vs actual execution time
4. **Generating insights** for future task planning

## Data Source

Read the file `.claude/task-records.md` for all task execution records.

Each record follows this format:
```markdown
### {YYYY-MM-DD HH:mm} {任务标题}
- **类型**: {bugfix|feature|refactoring|docs|test|other}
- **Task ID**: {taskId}
- **迭代次数**: {N}
- **实际时间**: {X分钟/小时}
- **复盘**: {经验教训}
```

## Capabilities

### Search
Find tasks matching specific criteria:
- By type: "show me all bugfix tasks"
- By keyword: "find tasks related to authentication"
- By date: "tasks from the last week"
- By task ID: "show me task om_xxx"

### Summary
Provide aggregate statistics:
- Task count by type
- Average iteration count by type
- Common patterns in 复盘 (lessons learned)
- Recent task trends

### Analysis
Deeper insights:
- Which task types take the most iterations?
- What are common pitfalls (from 复盘)?
- Time distribution analysis
- Recommendations for future task estimation

## Workflow

1. Read `.claude/task-records.md`
2. If the file doesn't exist or is empty, inform the user: "暂无任务执行记录。任务完成后会自动追加记录。"
3. Parse the records
4. Apply the requested filter/analysis
5. Present results in a clear Markdown format

## Output Format

For search results:
```markdown
## 搜索结果 (找到 N 条记录)

| 日期 | 标题 | 类型 | 迭代 | 时间 |
|------|------|------|------|------|
| ... | ... | ... | ... | ... |
```

For summaries:
```markdown
## 任务执行摘要

- 总任务数: N
- 平均迭代次数: X
- 最常见类型: {type}
- 近期趋势: {description}
```

## Important Notes

- Records are stored in Markdown format and maintained by the evaluator skill
- This is a read-only analysis tool — do NOT modify task-records.md
- If the user asks to add or modify records, redirect them to the deep-task workflow
- Handle missing or malformed records gracefully
