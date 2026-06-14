---
name: agentic-research
description: "Agentic research best practices. Use when performing research tasks, data analysis, literature review, or any task requiring systematic information gathering and synthesis. Keywords: 研究, 研究, research, 分析, analysis, 调研, investigation."
---

# Agentic Research Guide

## Context

You are performing a research task. This guide helps you avoid common pitfalls and follow best practices for systematic, high-quality research.

## Common Pitfalls to Avoid

### 1. Data Source Issues

**Problems to avoid:**
- Using unreliable or unverified data sources
- Switching to "convenient" sources after user guidance
- Forgetting user-specified source preferences

**Best practices:**
- Always prefer authoritative sources (official docs, peer-reviewed papers, established databases)
- When user specifies a data source, stick to it throughout the task
- If you must use alternative sources, explain why and get user confirmation
- Document your source choices for transparency

```
Good: "Based on the official API documentation..."
Bad: "I found this on a random blog..."
```

### 2. Data Processing Issues

**Problems to avoid:**
- Skipping data cleaning steps
- Using inappropriate data formats or precision
- Substituting real data with mock data without explicit permission
- Processing raw data without preprocessing, leading to poor performance

**Best practices:**
- Always clean and validate data before analysis
- Choose appropriate data types and precision levels
- NEVER use mock/simulated data unless explicitly requested
- Preprocess data for optimal performance (filter, aggregate, transform as needed)

```
Good: "I'll clean the data by removing null values and normalizing dates..."
Bad: "I'll use some sample data to demonstrate..."
```

### 3. Research Direction Issues

**Problems to avoid:**
- Spending excessive time on irrelevant details
- Missing obvious conclusions or insights
- Ignoring visualization insights
- Oscillating between approaches based on minor feedback

**Best practices:**
- Start with clear research objectives
- Prioritize analysis that directly addresses the core question
- Pay attention to obvious patterns and conclusions
- When interpreting visualizations, describe what you see before drawing conclusions
- When receiving feedback, understand the intent before making changes

**Research objective checklist:**
- [ ] What is the main question to answer?
- [ ] What are the key metrics or outcomes?
- [ ] What is the scope and what is out of scope?
- [ ] What level of detail is needed?

### 4. Learning and Knowledge Issues

**Problems to avoid:**
- Not reviewing relevant existing research or documentation
- Forgetting previously established context
- Failing to provide supporting evidence
- Repeating the same mistakes

**Best practices:**
- Before starting, review relevant docs, issues, or prior work
- Maintain context throughout the research session
- Always cite sources and provide evidence for claims
- When corrected, update your understanding for future reference

### 5. Knowledge Confusion Issues

**Problems to avoid:**
- Mixing up similar but distinct concepts
- Repeating errors after verbal correction
- Inconsistent application of learned knowledge

**Best practices:**
- When dealing with similar concepts, explicitly compare and contrast them
- If corrected, restate the correct understanding to confirm
- For complex topics, create structured summaries or comparison tables

### 6. Skill Overload Awareness

**Context:** Having too many skills can lead to poor skill selection, like an inexperienced waiter struggling with an oversized menu.

**Best practices:**
- Trust the skill matching system - relevant skills will be suggested
- Focus on the task at hand rather than exploring all available capabilities
- If a skill seems relevant, use it; don't second-guess the matching

## Research Workflow

### Phase 1: Planning

1. **Clarify objectives**: What question(s) need to be answered?
2. **Identify data sources**: Where will information come from?
3. **Define scope**: What's in scope and out of scope?
4. **Estimate effort**: Is this a quick lookup or deep analysis?

### Phase 2: Execution

1. **Gather data** from approved sources
2. **Clean and validate** data quality
3. **Analyze** using appropriate methods
4. **Document** findings with evidence

### Phase 3: Synthesis

1. **Summarize** key findings
2. **Visualize** if helpful (charts, tables, diagrams)
3. **Cite sources** for all claims
4. **Highlight limitations** and uncertainties

### Phase 4: Review

1. **Check completeness**: Did you answer the main question?
2. **Verify accuracy**: Are sources cited correctly?
3. **Get feedback**: Does the output meet user needs?

## Quality Checklist

Before completing a research task:

- [ ] All data from approved/reliable sources
- [ ] No mock data used without explicit permission
- [ ] Research objectives clearly addressed
- [ ] Evidence provided for key claims
- [ ] Sources properly cited
- [ ] Limitations acknowledged
- [ ] User can reproduce the findings

## Example: Good vs Bad Research

### Bad Example
```
"I searched for information about X and found some articles.
The data shows Y is better than Z. Here's my analysis..."
```
Problems: No sources cited, no evidence, vague data reference.

### Good Example
```
"Based on the official documentation from [source] and the
research paper [citation], I analyzed the differences between
Y and Z. Key findings:

1. **Performance**: Y showed 40% better latency (source: benchmark report)
2. **Cost**: Z is 20% cheaper for small workloads (source: pricing page)
3. **Limitation**: This analysis is based on synthetic benchmarks;
   real-world results may vary.

Sources:
- [1] Official docs: https://...
- [2] Research paper: https://...
"
```

## Report Templates

When producing research output, use the structured templates in the [report templates reference](./report-templates.md) as a starting point. Available templates:

| Template | Best For |
|----------|----------|
| Executive Summary | Quick overviews, decision-making |
| Full Report | Comprehensive analysis, documentation |
| Comparison | Evaluating 2+ options side-by-side |
| Annotated Bibliography | Literature review, source catalog |

Select the template that best matches the user's needs. Adapt sections as needed — templates are guidelines, not rigid requirements.

## Related

- Issue #1021: Research task common complaints and improvements
- Issue #963: GLM-5 infinite loop (extreme case of source selection issues)

## Loop-Driven Research (Async Mode)

When your research task is running inside a **Loop** (repeated execution via `loop_start`), your behavior must adapt. The Loop provides the execution framework — you provide the research intelligence.

### Identifying Loop-Driven Mode

You are in Loop-driven mode if:
- You see a `LOOP.md` or `RESEARCH.md` file in your working directory
- You were started by `loop_start` rather than a direct user message
- Your prompt includes instructions to continue an ongoing task

### Step Behavior (Each Loop Iteration)

At the **start** of each step:

1. **Read state files**: Check `LOOP.md`, `RESEARCH.md`, and any other state files for:
   - Current progress and what's been done
   - User feedback written by the initial conversation agent
   - Any direction changes or corrections
2. **Detect user feedback**: Look for sections like `## User Feedback` or `## Corrections` in `RESEARCH.md`. If found:
   - Evaluate whether the feedback changes the current step's direction
   - If yes: adjust your execution plan accordingly
   - If no: acknowledge but continue as planned
3. **Execute one coherent unit of work**: Do a meaningful chunk — don't just "continue" vaguely. Produce tangible output.
4. **Update state files**: Write your progress to `RESEARCH.md` so the next step (and the user) can see what happened.

### Key Decision Points

These are moments where user feedback is most likely to change your direction:

| Decision Point | What to Check |
|---|---|
| **Research goal clarification** | Does the user's feedback redefine the core question? |
| **Data source selection** | Did the user suggest different sources or approaches? |
| **Analysis direction** | Is your analysis drifting from the user's original intent? |
| **Conclusion validity** | Do your findings actually answer the user's question? |

### State File Conventions

When writing to `RESEARCH.md`:

```markdown
## Research Progress

### Completed
- [x] Step 1: Literature search (10 papers found)
- [x] Step 2: Data collection from [source]

### Current Step
- [ ] Step 3: Comparative analysis

## Key Findings So Far
1. Finding A (from [source])
2. Finding B (from [source])

## User Feedback (if any)
> User said: "Focus more on cost comparison"
→ Action: Adjusting analysis to emphasize cost metrics
```

### Async Communication Guidelines

- **You cannot ask the user questions directly** — you're running in a loop
- **Write findings clearly** so the user can review between steps
- **Flag uncertainties** in your state file: `⚠️ Unsure about X, proceeding with Y assumption`
- **Be decisive**: Make reasonable assumptions and document them rather than stalling
- **Acknowledge feedback**: When you detect user feedback, note how you incorporated it

### When to Stop Early

If at any point you determine:
- The research question is fully answered
- You've hit a dead end that requires user input
- The task is complete

Write a clear summary in `RESEARCH.md` under `## Conclusion` or `## Blocked`, and the loop should be stopped (via `loop_stop` or natural completion).
