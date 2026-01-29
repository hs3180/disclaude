---
name: deep-search
description: Conduct comprehensive research using WebSearch API and browser automation tools. Use for investigating complex topics that require thorough analysis across multiple authoritative sources.
argument-hint: [research topic]
disable-model-invocation: true
allowed-tools: WebSearch,mcp__playwright__browser_navigate,mcp__playwright__browser_run_code,mcp__playwright__browser_click,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot
---

# Deep Search

**Version:** 4.0.0

Advanced research capability that conducts systematic investigation using WebSearch API for discovery and browser automation tools for deep information collection from specific websites.

**What's New in v4.0.0:**
- ✅ **ULTRA-SIMPLIFIED:** Iterative loop approach - search → read → search → read
- ✅ **FLEXIBLE:** No rigid stages - research naturally evolves based on findings
- ✅ **ADAPTIVE:** Continue looping until satisfaction criteria is met
- ✅ **NATURAL:** Mimics how humans actually research - explore and refine

**Expected Duration:** 5-20 minutes depending on topic complexity.

## Tool Constraints

Available tools: WebSearch API and Playwright browser automation tools.

You can:
- Use WebSearch API for fast, efficient web searches
- Use browser automation tools to navigate and extract detailed content from websites
- Present research findings directly in the conversation

You cannot:
- Write to local files
- Read or edit existing local files
- Run bash commands or scripts

Research findings are presented directly in the conversation.

## Research Workflow

### The Iterative Loop: Search → Read → Search → Read ...

Research follows a natural, adaptive cycle:

```
┌──────────┐
│  Search  │  ← Use WebSearch API to discover relevant sources
└────┬─────┘
     │
     ▼
┌──────────┐
│  Read    │  ← Use browser automation for high-value sources
└────┬─────┘     OR read WebSearch results for simple content
     │
     ▼
┌──────────┐
│Evaluate  │  ← Satisfied? (Have we gathered enough?)
└────┬─────┘
     │
  ┌──┴──┐
  │     │
 No    Yes
  │     │
  ▼     ▼
Continue  Report
(search  (synthesize
based on  findings)
findings)
```

### How the Loop Works

**1. Search Phase**
- Use WebSearch API to find relevant information
- Start with broad queries, then refine based on what you discover
- Follow interesting leads and citations
- Adjust search terms as you learn more

**Search Optimization:**
- Use specific phrases: `"machine learning interpretability in healthcare"`
- Include temporal markers: `2024`, `latest`, `recent`
- Add qualifiers: `review`, `analysis`, `study`, `research`
- Vary perspectives: `advantages`, `challenges`, `comparison`, `best practices`
- Use industry terminology for better results

**Domain Quality Indicators:**
- **Authority**: .edu, .gov, established industry sites
- **Expertise**: Content by domain experts or practitioners
- **Depth**: Comprehensive coverage vs superficial mentions
- **Currency**: Recently updated content
- **Objectivity**: Balanced perspectives

**2. Read Phase**
- For high-value sources (official docs, research papers, comprehensive guides): Use browser automation tools
- For simple content (blog posts, news): WebSearch results are sufficient
- Extract key information, data points, quotes, and insights
- Note conflicting information or gaps

**When to use browser automation:**
- Official documentation sites with detailed technical content
- Research papers or academic publications
- Comprehensive guides or tutorials
- Sites requiring navigation beyond landing page

**When to skip browser automation:**
- Simple blog posts or news articles
- Paywalled or login-required content
- Sites with minimal information

**3. Evaluate Phase**
Ask yourself:
- Do I have enough information to answer the user's question?
- Are new searches returning redundant information?
- Have I covered the key aspects of the topic?
- Have I gathered 5-12 high-quality sources?

**Continue the loop if:**
- You discover gaps in your understanding
- New questions emerge from your findings
- You need to verify conflicting information
- You want to explore a specific aspect in more depth

**Stop the loop and report when:**
- Sufficient information gathered (typically 5-12 high-quality sources)
- New searches return redundant information without new insights
- Key aspects are well-covered
- Time invested is proportional to topic complexity (5-20 minutes typical)

### Synthesize Report

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

### Iterative Research Approach
- **Start broad, then narrow**: Begin with general searches, then drill down based on findings
- **Follow the trail**: Use citations and references from results to find more sources
- **Adapt as you learn**: Let your findings guide your next search queries
- **Cross-verify**: Look for multiple independent sources confirming critical information
- **Prioritize quality**: Depth over breadth - better to have 5 excellent sources than 20 mediocre ones
- **Embrace the loop**: Each cycle of search → read should refine your understanding

### Information Quality Assessment
- **Primary sources** > Secondary sources > Tertiary sources
- **Peer-reviewed** > Professional publications > General media
- **Recent data** preferred for fast-moving topics
- **Empirical evidence** > Expert opinion > Speculation
- **Multiple independent confirmations** for critical claims

### Search-Read Loop Examples

**Example 1: Research on AI in Healthcare**
```
Loop 1:
  Search: "AI in healthcare 2024 trends"
  Read: 3-5 high-level articles
  Evaluate: Need more specific info on regulations

Loop 2:
  Search: "FDA AI medical device regulation 2024"
  Read: Official FDA documentation (use browser automation)
  Evaluate: Need clinical trial data

Loop 3:
  Search: "AI clinical trials success rates 2024"
  Read: Research papers and studies
  Evaluate: Have enough info across key dimensions

Loop 4:
  Search: "AI healthcare challenges and limitations"
  Read: Critical perspectives
  Evaluate: Satisfied with breadth and depth → Report
```

**Example 2: Research on Renewable Energy**
```
Loop 1:
  Search: "renewable energy storage technologies 2024"
  Read: Industry reports and overview articles
  Evaluate: Want to compare specific technologies

Loop 2:
  Search: "lithium-ion vs flow batteries comparison"
  Read: Technical comparison studies
  Evaluate: Need cost data

Loop 3:
  Search: "battery storage cost per kWh 2024"
  Read: Market analysis and pricing data
  Evaluate: Information complete → Report
```

### When to Stop the Loop
Consider ending the research loop when:
- ✅ Sufficient information to answer the user's question (5-12 high-quality sources)
- ✅ New searches return redundant information without new insights
- ✅ Key aspects of the topic are well-covered
- ✅ Time invested is proportional to topic complexity (5-20 minutes typical)
- ✅ Both broad coverage and specific details are obtained

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

**How it works:**
1. You provide a research topic
2. AI performs iterative search → read loops
3. Each loop refines understanding based on findings
4. Research continues naturally until satisfaction criteria met
5. Comprehensive report synthesized from gathered information

**Expected Timeline:**
- Simple topics: 5-10 minutes (5-7 sources, 2-3 loops)
- Medium topics: 10-15 minutes (7-10 sources, 3-4 loops)
- Complex topics: 15-20 minutes (10-12 sources, 4-5 loops)

## Success Criteria

Research is successful when:
- ✅ Iterative search-read loops executed until satisfaction criteria met
- ✅ Comprehensive understanding across multiple dimensions (naturally discovered through loops)
- ✅ Information from 5-12 high-quality, authoritative sources
- ✅ Key findings clearly identified and well-supported
- ✅ Sources properly cited with URLs
- ✅ Conflicting perspectives or limitations acknowledged
- ✅ Practical insights or recommendations provided
- ✅ Research adapted based on findings (not following rigid plan)

**Quality Indicators:**
- Each search loop refined understanding or filled gaps
- High-value sources explored deeply via browser automation tools
- Multiple independent sources verify critical claims
- Both breadth and depth achieved naturally
- Time invested proportional to topic complexity
