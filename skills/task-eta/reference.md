# Task ETA Reference

## File Locations

| File | Purpose | Created By |
|------|---------|------------|
| `.claude/task-records.md` | Historical task execution records | task-eta skill |
| `.claude/eta-rules.md` | Evolving estimation rules | task-eta skill |

## Task Type Taxonomy

| Type | Description | Examples |
|------|-------------|----------|
| `bugfix` | Fix a bug or error | Login crash, API timeout, display issue |
| `feature-small` | Single function point | Add a button, new API endpoint, simple validation |
| `feature-medium` | Multiple components | Payment flow, search with filters, notification system |
| `feature-large` | Cross-cutting feature | Auth system, real-time collaboration, multi-tenant |
| `refactoring` | Code restructure | Extract module, change API design, migrate patterns |
| `documentation` | Docs update | README, API docs, inline comments |
| `test` | Test writing | Unit tests, integration tests, test fixtures |
| `investigation` | Problem diagnosis | Debug production issue, performance profiling |
| `chore` | Maintenance | Update deps, config changes, cleanup |

## Confidence Levels

| Level | Criteria |
|-------|----------|
| **高** | 3+ similar tasks in history with <20% deviation |
| **中** | 1-2 similar tasks or rules with moderate relevance |
| **低** | No similar tasks, rules only, or conflicting data |

## Recording Best Practices

### Good Retrospectives

- "低估了数据库迁移的复杂度，涉及外键约束和多表同步"
- "有现成的参考代码（PR #xxx），复用后比预估快"
- "第一次接触此模块，后续类似任务预计可以更快"

### Bad Retrospectives

- "花的时间比预计长" (too vague)
- "还行" (not informative)
- "" (empty)

## Rule Evolution Cycle

```
New task → Record estimate → Complete task → Record actual → Analyze deviation → Update rules
   ↑                                                                              ↓
   ←←←←←←←←←←←←←← Better estimates from evolved rules ←←←←←←←←←←←←←←←←←←←←←←
```
