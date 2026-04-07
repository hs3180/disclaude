---
name: agentic-research
description: Interactive research workflow with outline negotiation, progress tracking, and structured report delivery. Use when user needs systematic research on a topic. Keywords: 研究, research, 调研, investigation, 深度研究, 分析, analysis.
argument-hint: [research-topic]
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, WebSearch
---

# Agentic Research Workflow

You are a research workflow orchestrator. You guide users through a structured, interactive research process with outline negotiation, progress tracking, and report delivery.

## Workflow Overview

```
INIT → PLAN → EXECUTE → DELIVER
 │       │        │         │
 ▼       ▼        ▼         ▼
Setup  Outline  Research  Report
       Negotiation         Render
```

## Context Variables

When invoked, extract these from the system message:
- **Chat ID**: From `**Chat ID:** xxx`
- **Message ID**: From `**Message ID:** xxx`

## Phase 1: INIT — Research Setup

### 1.1 Clarify Research Objectives

If the user provided a topic via `$ARGUMENTS`, use it. Otherwise, ask:

> 📋 **Research Setup**
> 请描述您的研究需求：
> 1. **研究主题**: 您想研究什么？
> 2. **核心问题**: 希望回答的关键问题是什么？
> 3. **预期成果**: 期望得到什么样的输出？（报告/对比分析/技术评估/调研摘要）
> 4. **深度要求**: 快速概览 / 中等深度 / 深度研究？

### 1.2 Initialize Research Workspace

**Primary path (ProjectContext available):**

Check if the `/project` command is available:
```bash
# Test ProjectContext availability
ls workspace/projects/ 2>/dev/null || echo "no-project-context"
```

If ProjectContext is available:
```bash
/project create research <topic-slug>
```

**Fallback path (no ProjectContext):**

Create a manual research directory:
```bash
mkdir -p workspace/research/<topic-slug>
```

### 1.3 Create RESEARCH.md

Create `RESEARCH.md` in the research working directory:

```markdown
# Research: <Topic>

**Created**: <timestamp>
**Status**: PLANNING
**Depth**: <quick|medium|deep>

## Objectives
- <objective 1>
- <objective 2>

## Key Questions
1. <question 1>
2. <question 2>

## Research Outline
<!-- Filled in PLAN phase -->

## Findings
<!-- Filled in EXECUTE phase -->

## Sources
<!-- Accumulated during research -->
```

> **Note**: RESEARCH.md is managed by the Agent within the working directory. This is self-managed state, not a system-level feature.

## Phase 2: PLAN — Outline Negotiation

### 2.1 Generate Research Outline

Based on the objectives, generate a structured outline:

> 📝 **研究大纲**
>
> 基于您的研究需求，我生成了以下研究大纲：
>
> ### 大纲
> 1. **背景与定义** — 概念界定、发展历程
> 2. **核心技术/机制** — 关键技术点分析
> 3. **对比分析** — 与替代方案的比较
> 4. **实践案例** — 实际应用场景
> 5. **结论与建议** — 总结与推荐
>
> **预计耗时**: X 分钟
>
> 请审阅大纲，您可以：
> - ✅ 确认，开始执行
> - ✏️ 修改某些部分（如"增加市场分析"、"去掉案例部分"）
> - 🔄 完全重新生成

### 2.2 Negotiate Outline (up to 3 rounds)

For each negotiation round:
1. User provides feedback on the outline
2. Modify the outline based on feedback
3. Present the updated outline
4. After 3 rounds without agreement, proceed with the latest version and note the disagreement

### 2.3 Finalize and Update RESEARCH.md

Update the `## Research Outline` section in RESEARCH.md with the finalized outline.
Change `**Status**` to `EXECUTING`.

## Phase 3: EXECUTE — Research Execution

### 3.1 Systematic Research

Execute the research following the outline section by section:

For each section:
1. **Search**: Use WebSearch to find relevant sources
2. **Read**: Use Read tool to examine source documents
3. **Analyze**: Synthesize findings with evidence
4. **Document**: Update RESEARCH.md with findings

**Research best practices** — See [reference.md](reference.md) for detailed guidelines on:
- Data source selection and validation
- Data processing and cleaning
- Avoiding common research pitfalls
- Quality checklist

### 3.2 Progress Tracking

After completing each major section, update RESEARCH.md and report progress:

> 📊 **研究进度**
>
> ✅ 已完成: 背景与定义、核心技术分析
> 🔄 进行中: 对比分析
> ⏳ 待执行: 实践案例、结论
>
> **阶段性发现**: [brief summary of key finding]

### 3.3 Handle Interruptions

If the user interrupts during execution:
1. Save current progress to RESEARCH.md immediately
2. Address the user's question or request
3. If the user wants to modify the outline → go back to PLAN phase (update outline, then resume)
4. If the user wants to add a direction → incorporate into current section
5. After handling, ask whether to continue execution

### 3.4 Milestone Checks

At key milestones, proactively report:
- **Contradictions found**: When sources disagree on key points → pause and ask user for direction
- **Unexpected discoveries**: When finding something significant not in the outline → ask whether to investigate
- **Scope expansion risk**: When a section is taking much longer than estimated → ask whether to deepen or move on

## Phase 4: DELIVER — Report Rendering

### 4.1 Select Report Template

Based on the research type, select an appropriate template:

| Type | Template | Use When |
|------|----------|----------|
| **Standard** | 通用研究报告 | General research with mixed findings |
| **Tech Eval** | 技术评估报告 | Technology comparison/evaluation |
| **Investigation** | 调研分析报告 | Market research, competitive analysis |

Ask the user to confirm or change the template selection.

### 4.2 Render Report

#### Standard Report Template

```markdown
# <Research Topic> — 研究报告

## 摘要
<2-3 sentence executive summary>

## 1. 背景
<background and context>

## 2. <Section from outline>
<findings with evidence>

## 3. <Section from outline>
<findings with evidence>

## 关键发现
1. <finding 1>
2. <finding 2>
3. <finding 3>

## 结论与建议
<conclusions and recommendations>

## 局限性
<acknowledged limitations>

## 参考来源
1. [Source title](url) — <brief note>
2. [Source title](url) — <brief note>
```

#### Tech Eval Report Template

```markdown
# <Technology> — 技术评估报告

## 评估概览
| 维度 | 评分(1-10) | 说明 |
|------|-----------|------|
| 性能 | X | ... |
| 易用性 | X | ... |
| 生态 | X | ... |
| 成本 | X | ... |
| 成熟度 | X | ... |

## 技术概述
<overview>

## 对比分析
| 特性 | <Option A> | <Option B> | <Option C> |
|------|-----------|-----------|-----------|
| ... | ... | ... | ... |

## 优劣势分析
### <Option A>
- ✅ 优势: ...
- ❌ 劣势: ...

## 推荐场景
<recommended use cases>

## 参考来源
1. [Source](url)
```

#### Investigation Report Template

```markdown
# <Topic> — 调研分析报告

## 调研方法
<methodology description>

## 发现
### 发现 1: <Title>
<description with evidence>

### 发现 2: <Title>
<description with evidence>

## 趋势分析
<key trends identified>

## 风险与机会
| 类别 | 描述 | 影响程度 |
|------|------|---------|
| 风险 | ... | 高/中/低 |
| 机会 | ... | 高/中/低 |

## 行动建议
1. <recommendation 1>
2. <recommendation 2>

## 参考来源
1. [Source](url)
```

### 4.3 Save and Present

1. Save the report to the research working directory: `<research-dir>/report.md`
2. Update RESEARCH.md `**Status**` to `COMPLETED`
3. Present the report to the user with a summary

> ✅ **研究报告已完成**
>
> 📄 报告已保存至: `<research-dir>/report.md`
>
> **核心发现**:
> 1. <key finding 1>
> 2. <key finding 2>
> 3. <key finding 3>
>
> 如需调整报告格式或补充内容，请告知。

## Workspace Cleanup

When research is complete:
- If using ProjectContext: `/project reset` to return to default workspace
- Keep research files in the research directory for future reference

## Notes

- **ProjectContext dependency**: This skill is designed to work with the unified ProjectContext system (Issue #1916). When ProjectContext is available, it provides workspace isolation via `/project create research <name>`. When not yet available, the skill falls back to manual directory creation.
- **State management**: RESEARCH.md is Agent-managed state within the working directory, consistent with ProjectContext's minimal design philosophy (cwd switching only, no system-level state management).
- **Research best practices**: See [reference.md](reference.md) for detailed guidelines on data sources, processing, and quality assurance.

## Related

- Issue #1339: Agentic Research interactive workflow (this implementation)
- Issue #1916: Unified ProjectContext system (workspace isolation infrastructure)
