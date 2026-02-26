/**
 * Tool Fallback Configuration
 *
 * Defines fallback strategies when primary tools hit rate limits or become unavailable.
 * This module provides:
 * - Fallback chain definitions (primary → secondary → tertiary)
 * - Rate limit error detection
 * - User-friendly error messages with fallback suggestions
 *
 * @module config/tool-fallback
 */

/**
 * Fallback chain configuration for tools that may hit rate limits.
 *
 * Each entry maps a primary tool to an ordered list of fallback alternatives.
 * When the primary tool fails due to rate limits, the agent should try
 * alternatives in order.
 */
export const TOOL_FALLBACK_CHAINS: Record<string, FallbackChain> = {
  WebSearch: {
    description: 'Web search functionality',
    fallbacks: [
      {
        tool: 'mcp__playwright__browser_navigate + browser_snapshot',
        description: 'Use Playwright to navigate to search engine and extract results',
        instructions: `
1. Use browser_navigate to go to https://www.google.com or https://www.bing.com
2. Use browser_snapshot or browser_evaluate to extract search results
3. Parse the results from the page content`,
      },
    ],
    rateLimitPatterns: [
      /weekly.*usage.*limit/i,
      /monthly.*usage.*limit/i,
      /rate limit/i,
      /quota exceeded/i,
      /too many requests/i,
    ],
  },

  'mcp__web_reader__webReader': {
    description: 'Web page content fetching and reading',
    fallbacks: [
      {
        tool: 'mcp__playwright__browser_navigate + browser_snapshot',
        description: 'Use Playwright to navigate to URL and extract content',
        instructions: `
1. Use browser_navigate to go to the target URL
2. Wait for page load with browser_wait_for
3. Use browser_snapshot to get page content as markdown
4. Extract the relevant information`,
      },
    ],
    rateLimitPatterns: [
      /weekly.*usage.*limit/i,
      /monthly.*usage.*limit/i,
      /rate limit/i,
      /quota exceeded/i,
      /too many requests/i,
    ],
  },

  WebFetch: {
    description: 'Web content fetching',
    fallbacks: [
      {
        tool: 'mcp__playwright__browser_navigate + browser_snapshot',
        description: 'Use Playwright browser automation',
        instructions: `
1. Navigate to the URL using browser_navigate
2. Use browser_snapshot to get page content
3. Extract needed information`,
      },
      {
        tool: 'Bash + curl',
        description: 'Use curl command for simple HTTP requests',
        instructions: `
1. Use: curl -s "URL" | head -n 100
2. Parse the HTML/text response manually
Note: This works best for simple pages without JavaScript rendering`,
      },
    ],
    rateLimitPatterns: [
      /weekly.*usage.*limit/i,
      /monthly.*usage.*limit/i,
      /rate limit/i,
      /quota exceeded/i,
    ],
  },
};

/**
 * Represents a single fallback alternative for a tool.
 */
export interface FallbackOption {
  /** The tool or combination of tools to use as fallback */
  tool: string;
  /** Human-readable description of the fallback */
  description: string;
  /** Step-by-step instructions for using the fallback */
  instructions: string;
}

/**
 * Represents a complete fallback chain for a tool.
 */
export interface FallbackChain {
  /** Description of what the primary tool does */
  description: string;
  /** Ordered list of fallback alternatives (try in order) */
  fallbacks: FallbackOption[];
  /** Regex patterns to detect rate limit errors */
  rateLimitPatterns: RegExp[];
}

/**
 * Generic rate limit patterns that apply to all tools.
 */
const GENERIC_RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /usage limit/i,
  /quota exceeded/i,
  /too many requests/i,
  /won't be available until/i,
];

/**
 * Check if an error message indicates a rate limit or usage limit.
 *
 * @param toolName - Name of the tool that failed
 * @param errorMessage - Error message from the tool
 * @returns True if this appears to be a rate limit error
 */
export function isRateLimitError(toolName: string, errorMessage: string): boolean {
  const chain = TOOL_FALLBACK_CHAINS[toolName];

  // Check tool-specific patterns first
  if (chain) {
    const toolMatch = chain.rateLimitPatterns.some(pattern => pattern.test(errorMessage));
    if (toolMatch) {
      return true;
    }
  }

  // Fall back to generic patterns for all tools
  return GENERIC_RATE_LIMIT_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * Get fallback suggestions for a tool that hit rate limits.
 *
 * @param toolName - Name of the tool that failed
 * @returns Fallback chain if available, undefined otherwise
 */
export function getFallbackForTool(toolName: string): FallbackChain | undefined {
  return TOOL_FALLBACK_CHAINS[toolName];
}

/**
 * Generate a user-friendly error message with fallback suggestions.
 *
 * @param toolName - Name of the tool that failed
 * @param originalError - Original error message
 * @returns Enhanced error message with fallback suggestions
 */
export function generateFallbackErrorMessage(
  toolName: string,
  originalError: string
): string {
  const chain = TOOL_FALLBACK_CHAINS[toolName];

  if (!chain || chain.fallbacks.length === 0) {
    // No fallback available
    return `⚠️ ${toolName} is currently unavailable: ${originalError}

No automatic fallback is available for this tool. Please try again later or use an alternative approach.`;
  }

  // Build message with fallback suggestions
  const fallbackList = chain.fallbacks
    .map((f, i) => `${i + 1}. **${f.tool}**: ${f.description}`)
    .join('\n');

  return `⚠️ ${toolName} is currently unavailable: ${originalError}

**Alternative approaches you can try:**
${fallbackList}

Please try one of these alternatives to continue your task.`;
}

/**
 * Get all tools that have fallback configurations.
 *
 * @returns List of tool names with fallback support
 */
export function getToolsWithFallbacks(): string[] {
  return Object.keys(TOOL_FALLBACK_CHAINS);
}

/**
 * System prompt section for tool fallback guidelines.
 * Add this to agent prompts to inform about fallback strategies.
 */
export const TOOL_FALLBACK_SYSTEM_PROMPT = `
## Tool Fallback Guidelines

When a tool fails due to rate limits or usage limits, follow these fallback strategies:

### WebSearch Fallback
If WebSearch hits rate limits, use Playwright browser automation:
1. Navigate to a search engine: \`browser_navigate\` to https://www.google.com
2. Get page content: Use \`browser_snapshot\` to extract search results
3. Parse results from the page

### Web Content Fallback
If web content fetching tools (WebFetch, webReader) hit limits:
1. Use Playwright: \`browser_navigate\` to the URL
2. Wait for page load: \`browser_wait_for\` if needed
3. Extract content: \`browser_snapshot\` returns markdown content

### General Fallback Principles
- **Detect rate limits**: Look for messages like "usage limit", "rate limit", "quota exceeded"
- **Switch gracefully**: Don't fail the entire task; try alternatives
- **Inform the user**: Explain what happened and what alternative you're using
- **Continue the task**: Complete the user's request using available tools

### Example Rate Limit Response Handling
\`\`\`
❌ WebSearch: "The search tool has reached its weekly usage limit..."

→ Switching to Playwright browser automation...
→ Navigating to search engine...
→ Extracting results...
✓ Search completed using fallback method
\`\`\`
`;
