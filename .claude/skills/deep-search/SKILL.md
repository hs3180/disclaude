---
name: deep-search
description: Conduct comprehensive research using WebSearch API and web-extractor subagent. Use for investigating complex topics that require thorough analysis across multiple authoritative sources.
argument-hint: [research topic]
disable-model-invocation: true
allowed-tools: WebSearch,Task
---

# Deep Search

**Version:** 3.0.0

Advanced research capability that conducts systematic investigation using WebSearch API for discovery and web-extractor subagent for deep information collection from specific websites.

**What's New in v3.0.0:**
- ✅ **SIMPLIFIED:** Removed mandatory progress updates and stage completion checks
- ✅ **FLEXIBLE:** No predefined research outline - search adaptively based on findings
- ✅ **DIRECT:** Single comprehensive report output instead of two-step process
- ✅ **FASTER:** Streamlined workflow reduces overhead while maintaining quality

**Expected Duration:** 5-20 minutes depending on topic complexity.

## Tool Constraints

Available tools: WebSearch API and Task tool for subagent delegation.

You can:
- Use WebSearch API for fast, efficient web searches
- Use Task tool to delegate web extraction to specialized subagent
- Present research findings directly in the conversation

You cannot:
- Write to local files
- Read or edit existing local files
- Run bash commands or scripts
- Use browser automation tools directly

Research findings are presented directly in the conversation.

## Research Workflow

### Step 1: Intelligent Discovery

Use WebSearch API to explore the topic from multiple angles:

**Search Strategy:**
1. **Initial broad searches** - 3-5 searches to understand the topic landscape
2. **Targeted follow-up searches** - Based on initial findings, drill deeper into specific aspects
3. **Identify authoritative sources** - Look for official documentation, research papers, expert articles

**Search Optimization:**
- Use specific, targeted phrases: `"machine learning interpretability in healthcare"`
- Include temporal markers: `recent`, `2024`, `latest`
- Add qualifiers: `review`, `analysis`, `study`, `research`
- Vary perspectives: `advantages`, `challenges`, `comparison`, `best practices`
- Use industry terminology for better results

**Domain Quality Indicators:**
- **Authority**: .edu, .gov, established industry sites
- **Expertise**: Content by domain experts or practitioners
- **Depth**: Comprehensive coverage vs superficial mentions
- **Currency**: Recently updated content
- **Objectivity**: Balanced perspectives

### Step 2: Deep Extraction (Optional)

For high-value domains identified in Step 1, delegate to web-extractor subagent:

**When to use subagent:**
- Official documentation sites with detailed technical content
- Research papers or academic publications
- Comprehensive guides or tutorials
- Sites requiring navigation beyond landing page

**Delegation best practices:**
- Be specific about what information to collect
- Set appropriate depth (3-5 pages per domain typical)
- Provide context about the research topic
- Process results efficiently (extract key points)

**When to skip subagent:**
- Simple blog posts or news articles (WebSearch results are sufficient)
- Paywalled or login-required content
- Sites with minimal information

### Step 3: Synthesize Report

Present a comprehensive research report directly (no two-step process):

**Report Structure:**

```markdown
# Research Report: [Topic]

## Executive Summary
[3-5 sentence overview of most critical findings and insights]

## Key Findings
1. **[Key Finding 1]** - [One-sentence summary]
   - Supporting details and evidence
   - Source: [Domain](URL)
2. **[Key Finding 2]** - [One-sentence summary]
   - Supporting details and evidence
   - Source: [Domain](URL)
[Continue for 5-10 key findings]

## Detailed Analysis

### [Aspect/Dimension 1]
[Comprehensive analysis with data, quotes, and insights]
- **Source**: [Domain](URL)

### [Aspect/Dimension 2]
[Comprehensive analysis with data, quotes, and insights]
- **Source**: [Domain](URL)

[Continue for relevant aspects discovered during research]

## Cross-Source Analysis
- **Consensus**: What most sources agree on
- **Divergence**: Where sources disagree or offer different perspectives
- **Trends**: Patterns observed across sources
- **Gaps**: Questions that remain unanswered

## Data & Statistics
[Key quantitative findings]
| Metric | Value | Source | Date |
|--------|-------|--------|------|
| ... | ... | ... | ... |

## Recommended Resources
[Top 3-5 most valuable resources discovered]
1. **[Resource Name]** - [Why valuable] - [URL]

## Sources
[Comprehensive list of all sources cited]
1. **[Source Name]** - URL - [Brief note]
```

## Best Practices

### Search Strategy
- **Start broad, then narrow**: Begin with general searches, then drill down based on findings
- **Follow the trail**: Use citations and references from initial results to find more sources
- **Cross-verify**: Look for multiple independent sources confirming critical information
- **Prioritize quality**: Depth over breadth - better to have 5 excellent sources than 20 mediocre ones

### Information Quality Assessment
- **Primary sources** > Secondary sources > Tertiary sources
- **Peer-reviewed** > Professional publications > General media
- **Recent data** preferred for fast-moving topics
- **Empirical evidence** > Expert opinion > Speculation
- **Multiple independent confirmations** for critical claims

### When to Stop Research
Consider the research complete when:
- Sufficient information gathered to answer the user's question (typically 5-10 high-quality sources)
- New searches return redundant information without new insights
- Key aspects of the topic are well-covered
- Time invested is proportional to topic complexity (5-20 minutes typical)

## Usage

Activate by asking to:
- "deep search [topic]"
- "conduct deep research on [topic]"
- "comprehensive investigation of [topic]"
- "thoroughly research [topic]"

**Examples:**
- `deep search AI in healthcare 2024`
- `conduct deep research on quantum computing applications`
- `comprehensive investigation of remote work trends`
- `thoroughly research renewable energy storage`

**Expected Timeline:**
- Simple topics: 5-10 minutes (5-7 sources)
- Medium topics: 10-15 minutes (7-10 sources)
- Complex topics: 15-20 minutes (10-12 sources)

## Success Criteria

Research is successful when:
- ✅ Comprehensive understanding of the topic across multiple dimensions
- ✅ Information from 5-12 high-quality, authoritative sources
- ✅ Key findings clearly identified and well-supported
- ✅ Sources properly cited with URLs
- ✅ Conflicting perspectives or limitations acknowledged
- ✅ Practical insights or recommendations provided
