# Research Schedule Template

This template defines how agentic research tasks use the Loop System (#4039) for scheduled execution.

## Overview

Research tasks are executed via the Ralph Loop pattern: each tick, a fresh agent session reads a RESEARCH.md file (variant of LOOP.md), executes the next unchecked research step, and reports progress.

## RESEARCH.md Template

When initializing a research loop, create `{WORK_DIR}/RESEARCH.md` using this structure:

```markdown
# {研究主题}

## 研究问题

{需要回答的核心问题}

## 研究范围

**包含**: {需要覆盖的领域/数据源}
**排除**: {不在本次研究范围内的内容}

## 研究步骤

- [ ] 第一步：{具体的研究动作，如"收集X领域近3年的公开数据"}
- [ ] 第二步：{如"清洗和验证数据，检查数据源可靠性"}
- [ ] 第三步：{如"分析数据，提取关键趋势和模式"}
- [ ] 第四步：{如"对比不同方案的优劣势"}
- [ ] 第五步：{如"撰写研究结论和建议"}

## 数据源约束

- 优先使用权威来源（官方文档、学术论文、行业报告）
- 如需使用非权威来源，需注明并说明原因
- 禁止使用模拟/伪造数据

## 进度记录

<!-- agent 在此追加执行记录 -->
```

### Research-Specific Differences from Generic LOOP.md

| Aspect | Generic LOOP.md | Research RESEARCH.md |
|--------|----------------|---------------------|
| Data sources | Not specified | Must list constraints and preferred sources |
| Quality checks | Optional | Mandatory per step (source verification) |
| Progress format | Free-form | Structured: source + finding + confidence |
| Feedback handling | Basic | Uses async feedback from #4005 |
| Output | Task completion | Research report (see report-templates.md) |

## SCHEDULE.md Template

```markdown
---
name: "Research: {研究主题}"
cron: "{CRON_EXPRESSION}"
chatId: "{CHAT_ID}"
---

你是一个研究执行 agent。

## 任务

读取并执行 {WORK_DIR}/RESEARCH.md 中的下一个研究步骤。

## 执行要求

1. 每个步骤都要引用数据来源
2. 发现数据问题时，记录问题并调整方法
3. 每步完成后输出结构化进度卡片
4. 所有步骤完成后，生成研究报告

## 完成条件

当所有研究步骤都已完成时：
1. 生成最终研究报告（参考 report-templates.md）
2. 发送完成通知到群聊
3. 输出 <promise>DONE</promise>
```

## Integration with Agentic Research Skill

The research loop integrates with the existing agentic-research SKILL.md:

1. **Planning phase** → Creates RESEARCH.md with research steps
2. **Execution phase** → Loop ticks execute steps one at a time
3. **Feedback phase** → Each tick reads recent chat for user feedback (#4005)
4. **Synthesis phase** → Final tick generates research report

## Usage Example

```
User: "帮我调研一下主流 LLM API 的定价对比"

→ Loop skill initializes:
  1. Creates RESEARCH.md with 5 research steps
  2. Creates Feishu group "Research: LLM API 定价对比"
  3. Registers schedule (every 10 min)
  4. Returns confirmation

→ Schedule ticks:
  Tick 1: Agent reads RESEARCH.md → executes step 1 (收集定价数据) → checks off → exits
  Tick 2: Agent reads RESEARCH.md → executes step 2 (验证数据来源) → checks off → exits
  ...
  Tick 5: Agent generates final report → outputs <promise>DONE</promise> → schedule disabled
```

## Dependencies

- Loop System (#4039) — generic loop infrastructure
- Loop Skill (#4021) — initialization workflow
- Async Feedback (#4005) — user feedback during execution
- Report Templates (`report-templates.md`) — output format
