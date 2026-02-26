/**
 * Tool Fallback Guide - Provides guidance for tool degradation scenarios.
 *
 * When certain tools reach usage limits (e.g., WebSearch, webReader),
 * this guide helps the Agent understand available alternatives.
 *
 * @module config/tool-fallback-guide
 */

/**
 * Fallback guidance for when primary tools are unavailable.
 */
export const TOOL_FALLBACK_GUIDE = `
## Tool Limitations & Fallback Strategies

When a tool reports that it has reached its usage limit, follow these strategies:

### WebSearch Limitations
If WebSearch is unavailable (e.g., "weekly/monthly usage limit"):
1. **Use Playwright browser tools** as alternative:
   - Navigate to a search engine (Google, Bing, DuckDuckGo)
   - Perform the search manually using browser_navigate and browser_type
   - Extract results using browser_snapshot
2. **Inform the user** about the limitation and the alternative approach
3. **Example fallback message**: "WebSearch is currently unavailable. I'll use the browser to search for this information instead."

### webReader / WebFetch Limitations
If webReader or WebFetch is unavailable:
1. **Use Playwright browser tools**:
   - Navigate directly to the URL using browser_navigate
   - Extract content using browser_snapshot
2. **For simple pages**: browser_snapshot provides the page structure
3. **For complex pages**: Use browser_click, browser_wait_for as needed

### MCP Tool Limitations
If any MCP tool is unavailable:
1. **Check for alternatives** in the available tools list
2. **Use Bash commands** as a last resort for some operations
3. **Inform the user** about the limitation

### Error Recovery Template
When a tool fails due to limits:
\`\`\`
⚠️ [Tool Name] is temporarily unavailable (usage limit reached).

I'll use an alternative approach: [describe alternative]

[Proceed with alternative method]
\`\`\`

### Best Practices
1. **Always inform the user** when a tool is unavailable
2. **Provide clear alternatives** rather than failing
3. **Continue the task** using available tools
4. **Be transparent** about any limitations in the final response
`;

/**
 * Check if an error message indicates a tool usage limit.
 */
export function isToolLimitError(errorMessage: string): boolean {
  const limitPatterns = [
    /usage limit/i,
    /weekly.*limit/i,
    /monthly.*limit/i,
    /reached.*limit/i,
    /quota.*exceeded/i,
    /rate limit/i,
    /temporarily unavailable/i,
  ];

  return limitPatterns.some(pattern => pattern.test(errorMessage));
}

/**
 * Get fallback tool suggestion for a given tool name.
 */
export function getFallbackSuggestion(toolName: string): string | null {
  const fallbacks: Record<string, string> = {
    WebSearch: 'Use Playwright browser tools to navigate to a search engine and perform the search manually.',
    WebFetch: 'Use Playwright browser_navigate to visit the URL and browser_snapshot to extract content.',
    'mcp__web_reader__webReader': 'Use Playwright browser_navigate to visit the URL and browser_snapshot to extract content.',
  };

  return fallbacks[toolName] || null;
}

/**
 * Format a user-friendly message about tool limitations.
 */
export function formatLimitMessage(toolName: string, originalError: string): string {
  const fallback = getFallbackSuggestion(toolName);

  if (fallback) {
    return `⚠️ ${toolName} is temporarily unavailable. ${fallback}\n\nOriginal error: ${originalError}`;
  }

  return `⚠️ ${toolName} is temporarily unavailable: ${originalError}\n\nI'll try to proceed with available tools.`;
}
