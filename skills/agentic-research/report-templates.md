# Research Report Templates

Reference file for structured research output. Templates use `{placeholder}` syntax for variable substitution.

> **Language Adaptation**: Templates are written in English. Adapt the output language at render time based on the user's conversation context. If the user writes in Chinese, produce the report in Chinese; if in English, use English.

---

## Template Selection Guide

| Template | Best For | Length | Key Feature |
|----------|----------|--------|-------------|
| Executive Summary | Quick overviews, decision-making | Short | Bottom-line upfront |
| Full Report | Comprehensive analysis, documentation | Long | Structured evidence |
| Comparison | Evaluating 2+ options | Medium | Side-by-side analysis |
| Annotated Bibliography | Literature review, source catalog | Variable | Source-centric |

---

## 1. Executive Summary

Use when the reader needs a concise answer with key takeaways.

```markdown
# {Research Topic} — Executive Summary

**Date**: {date}
**Researcher**: {agent_name}
**Question**: {primary_research_question}

## Key Findings

1. **{Finding_1}**: {one_sentence_summary} ({source})
2. **{Finding_2}**: {one_sentence_summary} ({source})
3. **{Finding_3}**: {one_sentence_summary} ({source})

## Bottom Line

{2-3 sentence conclusion that directly answers the research question}

## Recommendations

- {recommendation_1}
- {recommendation_2}

## Limitations

{caveats, data gaps, or assumptions}

## Sources

- [1] {source_1}
- [2] {source_2}
```

---

## 2. Full Report

Use for in-depth analysis requiring evidence, methodology, and detailed findings.

```markdown
# {Research Topic} — Research Report

**Date**: {date}
**Scope**: {scope_description}
**Methodology**: {research_approach}

## Background

{context_and_motivation_for_research}

## Research Questions

1. {question_1}
2. {question_2}
3. {question_3}

## Methodology

{how_data_was_gathered_and_analyzed}

- **Data Sources**: {source_types}
- **Analysis Methods**: {methods_used}
- **Scope Limitations**: {what_was_excluded}

## Findings

### {Finding_Category_1}

{detailed_analysis_with_evidence}

- Evidence: {specific_data_point} ([source]({url}))
- Evidence: {specific_data_point} ([source]({url}))

### {Finding_Category_2}

{detailed_analysis_with_evidence}

- Evidence: {specific_data_point} ([source]({url}))
- Evidence: {specific_data_point} ([source]({url}))

### {Finding_Category_3}

{detailed_analysis_with_evidence}

- Evidence: {specific_data_point} ([source]({url}))
- Evidence: {specific_data_point} ([source]({url}))

## Analysis

{interpretation_and_synthesis_of_findings}

## Conclusions

1. {conclusion_1}
2. {conclusion_2}

## Recommendations

| Priority | Action | Rationale |
|----------|--------|-----------|
| High | {action_1} | {reason_1} |
| Medium | {action_2} | {reason_2} |
| Low | {action_3} | {reason_3} |

## Limitations & Future Research

- {limitation_1}
- {limitation_2}
- Suggested follow-up: {future_research_direction}

## Sources

1. {full_source_citation_1}
2. {full_source_citation_2}
3. {full_source_citation_3}
```

---

## 3. Comparison

Use when evaluating two or more options against defined criteria. The example below uses two subjects, but you can extend to three or more by adding columns to each table and rows to the scorecard.

```markdown
# {Subject_A} vs {Subject_B} [vs {Subject_C}] — Comparison Analysis

**Date**: {date}
**Purpose**: {why_this_comparison_matters}

## Overview

| Aspect | {Subject_A} | {Subject_B} |
|--------|-------------|-------------|
| Type | {type_a} | {type_b} |
| Primary Use | {use_a} | {use_b} |
| Maturity | {maturity_a} | {maturity_b} |

## Criteria Comparison

### {Criterion_1}: {criterion_description}

| | {Subject_A} | {Subject_B} |
|---|---|---|
| Rating | {rating_a} | {rating_b} |
| Detail | {detail_a} | {detail_b} |
| Source | [link]({url_a}) | [link]({url_b}) |

### {Criterion_2}: {criterion_description}

| | {Subject_A} | {Subject_B} |
|---|---|---|
| Rating | {rating_a} | {rating_b} |
| Detail | {detail_a} | {detail_b} |
| Source | [link]({url_a}) | [link]({url_b}) |

### {Criterion_3}: {criterion_description}

| | {Subject_A} | {Subject_B} |
|---|---|---|
| Rating | {rating_a} | {rating_b} |
| Detail | {detail_a} | {detail_b} |
| Source | [link]({url_a}) | [link]({url_b}) |

## Summary Scorecard

| Criterion | {Subject_A} | {Subject_B} | Winner |
|-----------|:-----------:|:-----------:|--------|
| {criterion_1} | {score} | {score} | {winner} |
| {criterion_2} | {score} | {score} | {winner} |
| {criterion_3} | {score} | {score} | {winner} |

## Verdict

**Use {Subject_A} when**: {use_case_a}

**Use {Subject_B} when**: {use_case_b}

**Overall**: {overall_recommendation}

## Sources

1. {full_source_citation_1}
2. {full_source_citation_2}
```

---

## 4. Annotated Bibliography

Use for literature reviews and source catalogs with critical evaluation.

```markdown
# {Research Topic} — Annotated Bibliography

**Date**: {date}
**Scope**: {scope_description}
**Sources Reviewed**: {count}

---

## {Source_Category_1}

### [1] {source_title}

**Authors**: {authors}
**Year**: {year}
**Type**: {paper/article/docs/book/website}
**URL**: {url}

**Summary**: {2-3 sentence description of content}

**Key Findings**:
- {finding_1}
- {finding_2}

**Relevance**: {how_this_source_relates_to_research_question}

**Quality Assessment**: {reliability_note}

---

### [2] {source_title}

**Authors**: {authors}
**Year**: {year}
**Type**: {type}
**URL**: {url}

**Summary**: {2-3 sentence description}

**Key Findings**:
- {finding_1}
- {finding_2}

**Relevance**: {relevance_note}

**Quality Assessment**: {reliability_note}

---

## {Source_Category_2}

### [3] {source_title}

**Authors**: {authors}
**Year**: {year}
**Type**: {type}
**URL**: {url}

**Summary**: {2-3 sentence description}

**Key Findings**:
- {finding_1}
- {finding_2}

**Relevance**: {relevance_note}

**Quality Assessment**: {reliability_note}

---

## Synthesis

### Common Themes
- {theme_1}: supported by sources [{n1}, {n2}]
- {theme_2}: supported by sources [{n3}, {n4}]

### Conflicting Findings
- {conflict_description}: sources [{n1}] vs [{n2}]

### Research Gaps
- {gap_1}
- {gap_2}

## Sources

1. {full_citation_1}
2. {full_citation_2}
3. {full_citation_3}
```

---

## Usage Notes

1. **Select the right template** based on the user's needs, not your preference. When unsure, ask the user what format they want.
2. **Adapt, don't copy**: Templates are starting points. Add or remove sections as needed.
3. **Finding counts are flexible**: Templates show 2-3 findings as examples. Use as many or as few as the data warrants.
4. **Always cite sources**: Every claim should have a source reference.
5. **Be honest about limitations**: Acknowledge data gaps and assumptions.
6. **Keep it actionable**: Reports should enable decisions, not just present data.
