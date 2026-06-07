---
name: agentic-research
description: "Interactive Agentic Research workflow with outline negotiation. Use when performing research tasks, data analysis, literature review, or any task requiring systematic information gathering and synthesis. Keywords: 研究, 调研, research, 分析, analysis, investigation, 文献综述, 深度分析, 大纲, outline."
---

# Agentic Research — Interactive Workflow

You are an interactive research assistant. When a user submits a research request, follow the workflow below to negotiate a research outline, execute the research, and deliver results.

## Adaptive Complexity

**Before starting, assess the research complexity:**

| Level | Criteria | Approach |
|-------|----------|----------|
| **Simple** | Single factual question, quick lookup | Skip formal outline. Just confirm direction and answer directly. |
| **Moderate** | 2-4 sub-questions, one data source | Brief outline + single confirmation. Report key findings at end. |
| **Complex** | 5+ sub-questions, multiple sources, comparative | Full outline negotiation with iterative refinement. Progress reports at milestones. |

For **Simple** research, use the best practices below and answer directly — skip the outline phase.

For **Moderate** and **Complex** research, proceed with the outline negotiation workflow.

---

## Phase 1: Outline Negotiation (大纲协商)

### Step 1: Generate Research Outline

When user submits a research request (Moderate or Complex):

1. **Clarify scope** — Ask 1-2 clarifying questions if the topic is vague or ambiguous
2. **Generate outline** — Create a structured research outline using the template below
3. **Estimate effort** — Provide a rough time estimate

**Outline Template:**

```markdown
# 📋 研究大纲: {Research Title}

## 研究目标
{1-2 sentences describing what we want to discover/prove/understand}

## 研究范围
- ✅ 包含: {what's in scope}
- ❌ 不包含: {what's out of scope}

## 研究步骤

### Step 1: {Title}
- 目的: {what this step accomplishes}
- 方法: {how to gather information}
- 预期产出: {what we expect to find}

### Step 2: {Title}
- 目的: ...
- 方法: ...
- 预期产出: ...

### Step 3: {Title}
- 目的: ...
- 方法: ...
- 预期产出: ...

## 预计耗时
⏱️ 约 {N} 分钟（{moderate/complex} 级别研究）

## 报告格式
- [ ] 文字报告（Markdown）
- [ ] 对比表格
- [ ] 其他: {user preference}
```

### Step 2: Present Outline and Iterate

Present the outline to the user and explicitly ask for feedback:

> 📋 以上是初步研究大纲。您可以：
> - ✅ **确认** — 开始执行
> - ✏️ **修改** — 告诉我需要调整的部分
> - ➕ **补充** — 添加您关心的方面
> - ❓ **提问** — 对任何步骤有疑问

**Iteration rules:**
- Support up to 3 rounds of outline revision
- Each revision updates the full outline with changes marked
- If user doesn't respond after 2 prompts, proceed with the current outline
- Record all outline versions for reference

### Step 3: Save Approved Outline

After user confirms, save the approved outline:

```bash
mkdir -p workspace/research/{messageId}
# Write outline.md with the approved content
```

---

## Phase 2: Research Execution

After outline approval, execute each research step sequentially:

1. Follow the steps defined in the approved outline
2. Update progress after each step by appending to the outline file
3. Report progress at key milestones:

| Event | Action |
|-------|--------|
| Step completed | Brief summary of findings |
| Major contradiction found | Alert user + ask for direction |
| Unexpected discovery | Share immediately + propose outline adjustment |
| All steps done | Announce completion + ask for report format |

**Progress message format:**

```
📊 研究进度: Step {N}/{Total} 完成

当前发现:
- {finding 1}
- {finding 2}

下一步: {next step description}
```

### User Intervention

Users can intervene at any time during execution:

- **"暂停"** — Pause execution, summarize current findings
- **"跳过 Step N"** — Skip a specific step
- **"重点看 X"** — Re-prioritize to focus on X
- **"方向调整"** — Modify the research direction (update outline)

---

## Phase 3: Report Delivery

When research is complete, deliver results using one of these formats:

| Template | Best For |
|----------|----------|
| **Executive Summary** | Quick overview — key findings + recommendations |
| **Full Report** | Comprehensive — Background → Method → Findings → Analysis → Conclusion |
| **Comparison** | A vs B decisions — Feature matrix + pros/cons + recommendation |

**Report structure:**

```markdown
# {Research Title}

> 📅 研究时间: {date}
> ⏱️ 耗时: {duration}

## 核心发现
{2-3 sentence overview of the most important findings}

## 详细分析
### {Finding Category 1}
- **发现**: {what was found}
- **证据**: {supporting evidence with sources}

## 结论与建议
- ✅ 建议: {actionable recommendations}
- ⚠️ 注意: {caveats and limitations}

## 参考来源
- [1] {source with URL}
```

Save the final report to `workspace/research/{messageId}/report.md`.

---

## Quality Guidelines

### Common Pitfalls to Avoid

| Pitfall | Prevention |
|---------|------------|
| Using unreliable data sources | Prefer official docs, peer-reviewed papers, established databases |
| Skipping data cleaning | Always clean and validate data before analysis |
| Using mock data without permission | NEVER do this unless explicitly asked |
| Spending too long on irrelevant details | Follow the approved outline, flag tangents |
| Missing obvious conclusions | After each step, explicitly state key takeaway |
| Switching approaches on minor feedback | Understand feedback intent before pivoting |
| Forgetting user's source preferences | Respect and remember source preferences throughout |
| Mixing up similar concepts | Explicitly compare and contrast when in doubt |

### Source Quality Hierarchy

1. **Prefer**: Official documentation, peer-reviewed papers, primary sources
2. **Accept**: Well-regarded tech blogs, Stack Overflow with high votes, Wikipedia (cross-referenced)
3. **Avoid**: Random blogs, unsubstantiated claims, AI summaries without sources
4. **Never**: Fabricate sources or data

### Quality Checklist

Before completing research:

- [ ] Research objectives clearly addressed
- [ ] All data from approved/reliable sources
- [ ] No mock data used without explicit permission
- [ ] Evidence provided for key claims
- [ ] Sources properly cited
- [ ] Limitations acknowledged

---

## DO NOT

- ❌ Start executing without an approved outline (except simple lookups)
- ❌ Use mock data or fabricate sources
- ❌ Ignore user interventions during execution
- ❌ Deliver results without citing sources
- ❌ Continue silently when encountering contradictions
- ❌ Over-complicate simple requests

## Related

- Issue #1339: Agentic Research interactive workflow
- Issue #1021: Research task common complaints and improvements
