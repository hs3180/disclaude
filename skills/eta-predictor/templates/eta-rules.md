# ETA Estimation Rules

> This file contains learned rules for estimating task completion time.
> Rules are updated by the `eta-predictor` skill's `learn` mode.

---

## Task Type Baseline Times

| Type | Baseline Time | Notes |
|------|---------------|-------|
| bugfix | 15-30 min | Depends on reproducibility |
| feature-small | 30-90 min | Single feature point, clear scope |
| feature-medium | 2-6 hours | Multiple components, some uncertainty |
| feature-large | 1-3 days | Architecture changes, multiple subtasks |
| refactoring | Varies | Depends on impact scope |
| docs | 15-60 min | Depends on depth and scope |
| test | 15-60 min | Depends on coverage requirements |
| chore | 5-30 min | Maintenance, config, dependency updates |
| research | 30 min - 2 hours | Investigation, analysis, prototyping |

---

## Complexity Multipliers

| Factor | Multiplier | Examples |
|--------|------------|----------|
| Security/auth involved | × 1.5 | Authentication, authorization, encryption |
| Core module changes | × 2.0 | Modifying core architecture or shared utilities |
| Existing reference code | × 0.7 | Similar patterns already in codebase |
| Third-party API integration | × 1.5 + debug | External services, webhooks, rate limits |
| Async/state management | × 1.5 | Race conditions, event handling, state machines |
| Cross-platform concern | × 1.3 | Must work on multiple platforms |
| No test coverage area | × 1.3 | Untested code, higher regression risk |
| Well-defined requirements | × 0.8 | Clear spec, known patterns, examples available |
| First time doing this type | × 1.5 | No prior experience with this task type |
| Multi-file changes needed | × 1.3 | Changes span more than 5 files |
| Database schema changes | × 1.5 | Migrations, data integrity concerns |

---

## Experience Rules

> Rules learned from specific task retrospectives. Each rule includes its source.

1. **涉及认证/安全的任务** → 基准时间 × 1.5
   - *Source: 2024-03-10 登录模块重构 (低估 50%)*

<!-- New rules are added by the `learn` mode -->

---

## Bias Analysis

> Common patterns of over/underestimation.

### Commonly Underestimated
- Tasks involving async logic and state management
- Tasks requiring multi-file coordination
- Tasks with unclear requirements

### Commonly Overestimated
- Simple CRUD operations
- Tasks with good reference implementations
- Well-documented library integrations

---

## Last Updated

- Created: {initialization date}
- Last learn: {date of last learn run}
