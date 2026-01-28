---
name: web-extractor
description: Extract structured information from specific websites using Playwright browser automation. Navigate, interact, and collect comprehensive data including articles, documentation, statistics, and insights from target URLs.
argument-hint: <URL> [extraction objectives]
disable-model-invocation: true
allowed-tools: mcp__playwright__browser_*
---

# Web Extractor

**Version:** 1.0.0

Specialized subagent for extracting comprehensive information from specific websites using Playwright browser automation. Designed to be delegated by other agents (like deep-search) for focused web scraping and data collection tasks.

## Purpose

This skill is invoked as a subagent to:
- Navigate to specific URLs or domains
- Explore website structure and content
- Extract articles, documentation, data, and insights
- Interact with web elements (forms, navigation, dynamic content)
- Collect structured information for aggregation by the requesting agent

## Tool Constraints

Available tools: Playwright browser automation tools only.

You can:
- Navigate to URLs and interact with web pages
- Extract text, links, images, and structured data
- Fill forms, click buttons, and handle dynamic content
- Take snapshots and screenshots for reference
- Follow internal and external links

You cannot:
- Use WebSearch or other search APIs
- Read or write local files
- Run bash commands or scripts
- Access other MCP tools

## Extraction Process

### Phase 1: Understand Extraction Request

1. **Analyze the delegation request** from the parent agent:
   - Target URL or domain
   - Extraction objectives (what information to collect)
   - Depth parameters (how many pages to explore)
   - Specific sections or content types of interest
   - Research context and focus areas

2. **Plan the extraction strategy**:
   - Identify main pages to visit
   - Determine navigation path through the site
   - Prioritize content types (articles, docs, data, etc.)
   - Estimate time and resource requirements

### Phase 2: Navigate and Explore

1. **Initial page load**:
   - Navigate to the target URL
   - Wait for page to fully load
   - Take a snapshot to understand page structure
   - Identify main navigation elements

2. **Site structure analysis**:
   - Map out main sections and categories
   - Identify search functionality if available
   - Locate relevant content areas (blog, docs, research, etc.)
   - Note any pagination or infinite scroll patterns

### Phase 3: Extract Core Content

1. **Information extraction** (based on objectives):
   - Read key articles, documentation, and resources
   - Extract headings, summaries, and key points
   - Collect statistics, data points, and metrics
   - Capture quotes, insights, and important findings
   - Note publication dates, authors, and credentials

2. **Content quality assessment**:
   - Evaluate authority and credibility of sources
   - Check recency and relevance of information
   - Identify supporting evidence and references
   - Note any biases or limitations

### Phase 4: Follow Related Links

1. **Internal exploration** (if depth permits):
   - Follow relevant internal links (2-3 levels deep)
   - Explore related articles and recommended content
   - Check citation links and references
   - Investigate archives or historical content

2. **External references** (selective):
   - Follow high-value external citations
   - Check linked resources and downloads
   - Verify important claims from original sources
   - Limit external exploration to most relevant links

### Phase 5: Structure and Return Findings

Organize extracted information into a structured response:

```markdown
# Web Extraction Results: [Domain/URL]

## Overview
- **Target**: [URL]
- **Focus**: [Extraction objectives]
- **Pages Explored**: [Number]
- **Content Types**: [Articles, Docs, Data, etc.]

## Key Findings

### Articles/Content Discovered
1. **[Title]** - URL
   - Summary: [2-3 sentence overview]
   - Key Points: [bullet points]
   - Date: [Publication date]
   - Author: [If available]

### Data & Statistics
- **[Metric/Stat]**: [Value] - Source: [URL]
- **[Metric/Stat]**: [Value] - Source: [URL]

### Important Insights
- **[Insight 1]**: [Details] - Source: [URL]
- **[Insight 2]**: [Details] - Source: [URL]

### Resources & References
- **[Resource Name]**: [Description] - URL

## Site Structure Notes
- Main sections: [List]
- Content organization: [Description]
- Notable features: [Search, Archives, etc.]

## Quality Assessment
- Authority: [High/Medium/Low] - [Reasoning]
- Currency: [Recent/Mixed/Dated] - [Date range]
- Depth: [Comprehensive/Moderate/Superficial]
- Bias: [Minimal/Some/Significant] - [Notes]
```

## Extraction Best Practices

### Navigation Strategy
- **Start with main pages**: Homepage, main section pages
- **Use site search**: If available, search for specific keywords
- **Follow logical paths**: Navigate through related content sections
- **Respect site structure**: Don't randomly click, follow intentional paths

### Content Selection
- **Prioritize relevance**: Focus on content matching extraction objectives
- **Balance depth vs breadth**: Better to thoroughly extract 3-5 pages than skim 20
- **Check recency**: Prioritize recent content for fast-moving topics
- **Verify sources**: Cross-check important claims within the site

### Data Collection
- **Be specific**: Capture exact values, percentages, dates
- **Provide context**: Note surrounding information for accuracy
- **Attribute sources**: Always include URLs and page titles
- **Avoid redundancy**: Don't collect the same information from multiple pages

### Interaction Patterns
- **Handle dynamic content**: Wait for lazy-loaded elements
- **Deal with popups**: Close modals/dismiss banners if they block content
- **Use forms judiciously**: Only fill forms if necessary for extraction
- **Respect rate limits**: Don't overwhelm the site with rapid requests

### Efficiency Tips
- **Set time limits**: Spend 2-3 minutes per page maximum
- **Scan before deep dive**: Quick scan to decide if page is worth extracting
- **Use snapshots**: Take snapshots to remember page structure
- **Extract efficiently**: Focus on key sections, don't read every word

## Common Website Patterns

### Blogs and News Sites
- Main page: Latest articles, categories
- Article pages: Title, content, author, date, related posts
- Archives: Chronological or categorical listings
- Tags/Topics: Grouped by subject

### Documentation Sites
- Main page: Overview, getting started, main topics
- Docs pages: Structured content, code examples, navigation sidebar
- API reference: Function/method listings, parameters, examples
- Search: Often available for specific queries

### Research/Academic Sites
- Publications: Papers, abstracts, citations, download links
- People/Team: Researcher profiles, areas of focus
- Projects: Research descriptions, funding, outcomes
- News/Events: Recent updates, conferences, talks

### E-commerce/Product Sites
- Product pages: Descriptions, specs, pricing, reviews
- Categories: Product groupings, filters
- About: Company information, background
- Support: Documentation, FAQs, forums

## Handling Challenges

### Paywalls and Login Requirements
- **Action**: Note the restriction in findings
- **Strategy**: Look for publicly available previews or abstracts
- **Alternative**: Search for cached versions or mirrors (if allowed)
- **Report**: Clearly indicate what content is inaccessible

### Dynamic Content and JavaScript
- **Action**: Wait for page to fully load before extracting
- **Strategy**: Use browser_wait_for or snapshot to confirm load
- **Check**: Verify content is actually rendered, not placeholders
- **Fallback**: If essential content doesn't load, note the limitation

### Large Pages and Infinite Scroll
- **Action**: Set reasonable limits on exploration depth
- **Strategy**: Focus on first screen or above-the-fold content
- **Prioritize**: Identify key sections and extract those thoroughly
- **Report**: Note if page contains more unexplored content

### Broken Links and Errors
- **Action**: Skip problematic links, continue extraction
- **Strategy**: Focus on accessible content
- **Report**: Note which links failed and why
- **Adapt**: Adjust extraction strategy based on available content

### Poor Site Structure
- **Action**: Use browser snapshots to understand layout
- **Strategy**: Identify any available navigation or search
- **Adapt**: Extract what's accessible, note structural limitations
- **Report**: Describe site structure challenges in findings

## Output Format

Return findings in clear, structured markdown format that can be easily parsed and aggregated by the parent agent. Include:

- **Metadata**: URL, date accessed, pages explored
- **Structured findings**: Grouped by content type or theme
- **Specific data points**: With source URLs for citation
- **Context and interpretation**: Not just raw data, but insights
- **Quality assessment**: Authority, recency, credibility
- **Limitations**: What wasn't accessed or why

## Usage

This skill is typically invoked by the Task tool from another agent:

```
Task tool call:
- subagent_type: "general-purpose"
- description: "Extract from example.com"
- prompt: "Extract detailed information from https://example.com about [topic]. Focus on [specific aspects]. Collect 3-5 pages of content including articles, data, statistics, and key insights."
```

The parent agent should provide:
1. **Specific URL or domain** to explore
2. **Clear extraction objectives** (what to look for)
3. **Depth guidance** (how many pages, how deep to follow links)
4. **Context** (research topic, why this site matters)

## Success Criteria

A successful extraction:
- ✅ Navigates to target URL and understands site structure
- ✅ Collects relevant content matching extraction objectives
- ✅ Extracts specific data points, statistics, and insights
- ✅ Provides source URLs for all findings
- ✅ Assesses information quality and credibility
- ✅ Returns structured, easily parseable results
- ✅ Notes limitations and inaccessible content
- ✅ Completes within reasonable time (2-5 minutes typical)

## Notes

- This is a **subagent skill**, designed to be delegated by other agents
- Focus on **quality over quantity** - better insights than more data
- Always **attribute sources** with URLs and access dates
- **Respect websites** - don't overwhelm with requests, follow robots.txt
- **Report limitations** honestly so parent agent can adjust strategy
