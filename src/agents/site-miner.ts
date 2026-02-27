/**
 * SiteMiner - Site information mining Subagent using Playwright browser automation.
 *
 * This Subagent isolates Playwright MCP interactions to:
 * 1. Reduce context noise - Playwright generates large context
 * 2. Improve success rate - Focused environment for browser automation
 * 3. Keep main context clean - Browser interactions don't pollute Pilot's context
 *
 * Technical Note: Playwright MCP uses stdio communication. To avoid conflicts with
 * the main agent's stdio, this Subagent runs in a forked context using the SDK's
 * built-in context isolation mechanism.
 *
 * @module agents/site-miner
 */

import { getProvider, type AgentQueryOptions } from '../sdk/index.js';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { buildSdkEnv } from '../utils/sdk.js';
import type { BaseAgentConfig } from './base-agent.js';

const logger = createLogger('SiteMiner');

/**
 * Result from site mining operation.
 */
export interface SiteMinerResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Target URL that was mined */
  target_url: string;
  /** Information extracted from the site */
  information_found: Record<string, unknown>;
  /** Brief summary of findings */
  summary: string;
  /** Path to screenshot evidence (optional) */
  evidence_path?: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Any notes or caveats */
  notes?: string;
}

/**
 * Options for site mining operation.
 */
export interface SiteMinerOptions {
  /** Target URL to mine */
  url: string;
  /** Task description - what information to extract */
  task: string;
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number;
  /** Whether to take a screenshot for evidence */
  takeScreenshot?: boolean;
}

/**
 * Check if Playwright MCP is configured.
 *
 * @returns true if Playwright MCP server is available
 */
export function isPlaywrightAvailable(): boolean {
  const mcpServers = Config.getMcpServersConfig();
  return !!(mcpServers?.playwright);
}

/**
 * Run the SiteMiner Subagent to extract information from a website.
 *
 * This function creates an isolated agent context with Playwright MCP tools
 * to mine information from the specified website.
 *
 * @param options - Mining options including URL and task description
 * @returns Structured result with extracted information
 *
 * @example
 * ```typescript
 * const result = await runSiteMiner({
 *   url: 'https://github.com/trending',
 *   task: 'Extract the top 5 trending repositories with their names, stars, and descriptions',
 * });
 *
 * console.log(result.information_found);
 * // [{ name: 'repo/name', stars: '1234', description: '...' }, ...]
 * ```
 */
export async function runSiteMiner(options: SiteMinerOptions): Promise<SiteMinerResult> {
  const { url, task, timeout = 60000, takeScreenshot = false } = options;

  logger.info({ url, task, timeout }, 'Starting site mining operation');

  // Check if Playwright is available
  if (!isPlaywrightAvailable()) {
    logger.warn('Playwright MCP not configured');
    return {
      success: false,
      target_url: url,
      information_found: {},
      summary: 'Playwright MCP not configured',
      confidence: 0,
      notes: 'Add playwright MCP server to disclaude.config.yaml under tools.mcpServers',
    };
  }

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();
  const loggingConfig = Config.getLoggingConfig();

  // Build MCP servers - only Playwright for this Subagent
  const mcpServers: Record<string, unknown> = {};

  // Get Playwright MCP config from user's config file
  const configuredMcpServers = Config.getMcpServersConfig();
  if (configuredMcpServers?.playwright) {
    mcpServers.playwright = {
      type: 'stdio',
      command: configuredMcpServers.playwright.command,
      args: configuredMcpServers.playwright.args || [],
      ...(configuredMcpServers.playwright.env && { env: configuredMcpServers.playwright.env }),
    };
  }

  // Build SDK options with forked context for isolation
  const sdkOptions: AgentQueryOptions = {
    cwd: Config.getWorkspaceDir(),
    permissionMode: 'bypassPermissions',
    settingSources: ['project'],
    // Only allow Playwright MCP tools + basic file operations for saving evidence
    allowedTools: [
      'Read',
      'Write',
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_snapshot',
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_type',
      'mcp__playwright__browser_wait_for',
      'mcp__playwright__browser_take_screenshot',
      'mcp__playwright__browser_scroll',
      'mcp__playwright__browser_hover',
      'mcp__playwright__browser_drag',
      'mcp__playwright__browser_select',
      'mcp__playwright__browser_press',
      'mcp__playwright__browser_file_upload',
    ],
    mcpServers: mcpServers as Record<string, import('../sdk/types.js').McpServerConfig>,
    env: buildSdkEnv(
      agentConfig.apiKey,
      agentConfig.apiBaseUrl,
      Config.getGlobalEnv(),
      loggingConfig.sdkDebug
    ),
    model: agentConfig.model,
  };

  // Build the prompt
  const prompt = buildSiteMinerPrompt(url, task, takeScreenshot);

  logger.debug({ prompt, mcpServers: Object.keys(mcpServers) }, 'Starting isolated query');

  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      logger.warn({ url, timeout }, 'Site mining timed out');
    }, timeout);

    // Get SDK provider
    const provider = getProvider();

    // Run the query in isolated context
    const queryIterator = provider.queryOnce(prompt, sdkOptions);

    // Collect results
    let finalContent = '';
    let resultReceived = false;

    for await (const message of queryIterator) {
      // Check for abort
      if (controller.signal.aborted) {
        break;
      }

      // Parse message type
      if (message.type === 'result') {
        resultReceived = true;
        finalContent = message.content;
        logger.debug({ contentLength: finalContent.length }, 'Result received');
      } else if (message.type === 'text') {
        // Intermediate output
        if (message.content) {
          logger.debug({ contentLength: message.content.length }, 'Intermediate output');
        }
      }
    }

    clearTimeout(timeoutId);

    if (!resultReceived) {
      logger.warn('No result received from SiteMiner');
      return {
        success: false,
        target_url: url,
        information_found: {},
        summary: 'No result received from mining operation',
        confidence: 0,
      };
    }

    // Parse the result
    const result = parseSiteMinerResult(finalContent, url);
    logger.info({ success: result.success, confidence: result.confidence }, 'Site mining completed');

    return result;

  } catch (error) {
    const err = error as Error;
    logger.error({ err, url }, 'Site mining failed');

    // Handle timeout
    if (err.name === 'AbortError') {
      return {
        success: false,
        target_url: url,
        information_found: {},
        summary: 'Operation timed out',
        confidence: 0,
        notes: `Timeout after ${timeout}ms`,
      };
    }

    return {
      success: false,
      target_url: url,
      information_found: {},
      summary: `Error: ${err.message}`,
      confidence: 0,
      notes: err.stack,
    };
  }
}

/**
 * Build the prompt for the SiteMiner Subagent.
 */
function buildSiteMinerPrompt(url: string, task: string, takeScreenshot: boolean): string {
  return `You are the Site Miner Agent. Your task is to extract information from a specific website.

## Target
- **URL**: ${url}
- **Task**: ${task}

## Instructions

1. **Navigate** to the URL using \`browser_navigate\`
2. **Wait** for the page to load completely
3. **Snapshot** the page using \`browser_snapshot\` (preferred over screenshot)
4. **Extract** the requested information
5. **Return** results in JSON format${takeScreenshot ? '\n6. **Evidence**: Take a screenshot using `browser_take_screenshot` and save it' : ''}

## Output Format

Return ONLY a JSON object in this exact format:

\`\`\`json
{
  "success": true,
  "target_url": "${url}",
  "information_found": {
    // Your extracted data here
  },
  "summary": "Brief summary of what you found",
  "confidence": 0.95,
  "notes": "Any issues or caveats (optional)"
}
\`\`\`

## Important Rules

- If the page fails to load, set \`success: false\` and explain in \`notes\`
- If you can't find all information, extract what you can and lower \`confidence\`
- Do NOT include any text outside the JSON object
- Focus on accuracy over completeness

Begin mining now.`;
}

/**
 * Parse the SiteMiner result from the agent output.
 */
function parseSiteMinerResult(content: string, url: string): SiteMinerResult {
  // Default result
  const defaultResult: SiteMinerResult = {
    success: false,
    target_url: url,
    information_found: {},
    summary: 'Failed to parse result',
    confidence: 0,
  };

  try {
    // Try to extract JSON from the content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('No JSON found in result');
      return {
        ...defaultResult,
        summary: content.slice(0, 500), // Return first 500 chars as summary
        notes: 'Could not parse JSON from response',
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    return {
      success: typeof parsed.success === 'boolean' ? parsed.success : false,
      target_url: parsed.target_url || url,
      information_found: parsed.information_found || {},
      summary: parsed.summary || 'No summary provided',
      evidence_path: parsed.evidence_path,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      notes: parsed.notes,
    };

  } catch (error) {
    logger.error({ error, content: content.slice(0, 200) }, 'Failed to parse SiteMiner result');
    return {
      ...defaultResult,
      summary: content.slice(0, 500),
      notes: `Parse error: ${(error as Error).message}`,
    };
  }
}

/**
 * Export a factory function for convenience.
 */
export function createSiteMiner(_config?: Partial<BaseAgentConfig>): typeof runSiteMiner {
  // SiteMiner uses global config, but this allows for future customization
  return runSiteMiner;
}
