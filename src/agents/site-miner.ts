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

import { z } from 'zod';
import { getProvider, type AgentQueryOptions } from '../sdk/index.js';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { buildSdkEnv } from '../utils/sdk.js';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';
import type { Subagent, UserInput, SubagentConfig } from './types.js';
import type { InlineToolDefinition, McpServerConfig } from '../sdk/types.js';
import type { AgentMessage } from '../types/agent.js';

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
 * SiteMiner - Site information mining Subagent.
 *
 * Implements Subagent interface (extends SkillAgent) for:
 * - Single-shot task execution via execute()
 * - Tool encapsulation via asTool()
 * - MCP server configuration via getMcpServer()
 *
 * @example
 * ```typescript
 * const siteMiner = new SiteMiner(config);
 *
 * // Use as SkillAgent
 * for await (const response of siteMiner.execute('Extract data from https://example.com')) {
 *   console.log(response.content);
 * }
 *
 * // Or use as tool definition for other agents
 * const toolDef = siteMiner.asTool();
 *
 * siteMiner.cleanup();
 * ```
 */
export class SiteMiner extends BaseAgent implements Subagent {
  /** Agent type identifier - subagent is a distinct type (Issue #325) */
  readonly type = 'subagent' as const;

  /** Agent name for logging */
  readonly name = 'SiteMiner';

  /** Default timeout for mining operations */
  private readonly defaultTimeout: number;

  /**
   * Create a SiteMiner instance.
   * Uses SubagentConfig for unified configuration structure (Issue #327).
   */
  constructor(config: SubagentConfig = {}) {
    super(config);
    this.defaultTimeout = config.defaultTimeout ?? 60000;
  }

  protected getAgentName(): string {
    return 'SiteMiner';
  }

  /**
   * Execute a site mining task.
   *
   * Accepts either:
   * - A string prompt (interpreted as mining instructions)
   * - A UserInput array (for structured input)
   *
   * @param input - Task input as string or UserInput array
   * @yields AgentMessage responses
   */
  async *execute(input: string | UserInput[]): AsyncGenerator<AgentMessage> {
    // Parse input to extract options
    const options = this.parseInput(input);

    this.logger.info({ options }, 'Starting site mining operation');

    // Check if Playwright is available
    if (!isPlaywrightAvailable()) {
      this.logger.warn('Playwright MCP not configured');
      yield {
        content: JSON.stringify({
          success: false,
          target_url: options.url,
          information_found: {},
          summary: 'Playwright MCP not configured',
          confidence: 0,
          notes: 'Add playwright MCP server to disclaude.config.yaml under tools.mcpServers',
        }),
        role: 'assistant',
        messageType: 'result',
      };
      return;
    }

    // Build SDK options
    const sdkOptions = this.createSdkOptions({
      allowedTools: this.getAllowedTools(),
      mcpServers: this.getMcpServersConfig(),
    });

    // Build the prompt
    const prompt = this.buildSiteMinerPrompt(options);

    this.logger.debug({ prompt }, 'Starting isolated query');

    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        this.logger.warn({ timeout: options.timeout }, 'Site mining timed out');
      }, options.timeout ?? this.defaultTimeout);

      // Run the query in isolated context
      for await (const { parsed } of this.queryOnce(prompt, sdkOptions)) {
        // Check for abort
        if (controller.signal.aborted) {
          break;
        }

        yield this.formatMessage(parsed);

        // If this is the final result, parse and return
        if (parsed.type === 'result') {
          const result = this.parseSiteMinerResult(parsed.content, options.url);
          this.logger.info(
            { success: result.success, confidence: result.confidence },
            'Site mining completed'
          );
        }
      }

      clearTimeout(timeoutId);
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, url: options.url }, 'Site mining failed');

      // Handle timeout
      if (err.name === 'AbortError') {
        yield {
          content: JSON.stringify({
            success: false,
            target_url: options.url,
            information_found: {},
            summary: 'Operation timed out',
            confidence: 0,
            notes: `Timeout after ${options.timeout ?? this.defaultTimeout}ms`,
          }),
          role: 'assistant',
          messageType: 'error',
        };
        return;
      }

      yield {
        content: JSON.stringify({
          success: false,
          target_url: options.url,
          information_found: {},
          summary: `Error: ${err.message}`,
          confidence: 0,
          notes: err.stack,
        }),
        role: 'assistant',
        messageType: 'error',
      };
    }
  }

  /**
   * Get the agent's tool definition for use by other agents.
   *
   * Returns an InlineToolDefinition that can be added to an
   * inline MCP server, allowing other agents to invoke this
   * subagent as a tool.
   *
   * @returns Tool definition for MCP registration
   */
  asTool(): InlineToolDefinition<SiteMinerOptions, SiteMinerResult> {
    return {
      name: 'site_miner',
      description: `Extract information from a website using Playwright browser automation.
Use this tool when you need to:
- Extract data from web pages
- Navigate websites and collect information
- Take screenshots of web pages
- Fill forms and interact with web elements

The tool returns structured results with extracted information and confidence scores.`,
      parameters: z.object({
        url: z.string().describe('Target URL to mine'),
        task: z.string().describe('Task description - what information to extract'),
        timeout: z.number().optional().default(60000).describe('Timeout in milliseconds'),
        takeScreenshot: z.boolean().optional().default(false).describe('Whether to take a screenshot for evidence'),
      }),
      handler: (params: SiteMinerOptions): Promise<SiteMinerResult> => {
        return this.runMining(params);
      },
    };
  }

  /**
   * Get MCP server configuration for standalone execution.
   *
   * Returns configuration for running this subagent with its
   * own isolated MCP server (e.g., for context isolation).
   *
   * @returns MCP server configuration with Playwright tools
   */
  getMcpServer(): McpServerConfig | undefined {
    const configuredMcpServers = Config.getMcpServersConfig();

    if (!configuredMcpServers?.playwright) {
      return undefined;
    }

    return {
      type: 'stdio',
      name: 'site-miner-playwright',
      command: configuredMcpServers.playwright.command,
      args: configuredMcpServers.playwright.args || [],
      ...(configuredMcpServers.playwright.env && { env: configuredMcpServers.playwright.env }),
    };
  }

  /**
   * Run a mining operation and return the result.
   *
   * This is the internal implementation used by asTool() handler.
   *
   * @param options - Mining options
   * @returns Structured mining result
   */
  private async runMining(options: SiteMinerOptions): Promise<SiteMinerResult> {
    const { url, task, timeout = this.defaultTimeout, takeScreenshot = false } = options;

    logger.info({ url, task, timeout }, 'Running site mining operation');

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

    // Build SDK options
    const sdkOptions: AgentQueryOptions = {
      cwd: Config.getWorkspaceDir(),
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],
      allowedTools: this.getAllowedTools(),
      mcpServers: this.getMcpServersConfig() as Record<string, McpServerConfig>,
      env: buildSdkEnv(
        this.apiKey,
        this.apiBaseUrl,
        Config.getGlobalEnv(),
        Config.getLoggingConfig().sdkDebug
      ),
      model: this.model,
    };

    // Build the prompt
    const prompt = this.buildSiteMinerPrompt({ url, task, timeout, takeScreenshot });

    logger.debug({ prompt }, 'Starting isolated query');

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
      const result = this.parseSiteMinerResult(finalContent, url);
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
   * Parse input to extract mining options.
   */
  private parseInput(input: string | UserInput[]): SiteMinerOptions {
    if (typeof input === 'string') {
      // Try to parse as JSON
      try {
        const parsed = JSON.parse(input);
        if (parsed.url && parsed.task) {
          return {
            url: parsed.url,
            task: parsed.task,
            timeout: parsed.timeout,
            takeScreenshot: parsed.takeScreenshot,
          };
        }
      } catch {
        // Not JSON, try to extract URL and task from string
        const urlMatch = input.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          return {
            url: urlMatch[0],
            task: input.replace(urlMatch[0], '').trim() || 'Extract information',
          };
        }
      }

      // Default: use entire input as task with placeholder URL
      return {
        url: 'about:blank',
        task: input,
      };
    }

    // UserInput array - concatenate content
    const content = input.map((i) => i.content).join('\n');
    return this.parseInput(content);
  }

  /**
   * Get allowed tools for SiteMiner.
   */
  private getAllowedTools(): string[] {
    return [
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
    ];
  }

  /**
   * Get MCP servers configuration for SiteMiner.
   */
  private getMcpServersConfig(): Record<string, unknown> {
    const mcpServers: Record<string, unknown> = {};
    const configuredMcpServers = Config.getMcpServersConfig();

    if (configuredMcpServers?.playwright) {
      mcpServers.playwright = {
        type: 'stdio',
        command: configuredMcpServers.playwright.command,
        args: configuredMcpServers.playwright.args || [],
        ...(configuredMcpServers.playwright.env && { env: configuredMcpServers.playwright.env }),
      };
    }

    return mcpServers;
  }

  /**
   * Build the prompt for the SiteMiner Subagent.
   */
  private buildSiteMinerPrompt(options: SiteMinerOptions): string {
    const { url, task, takeScreenshot = false } = options;

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
  private parseSiteMinerResult(content: string, url: string): SiteMinerResult {
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
}

// ============================================================================
// Legacy Function Exports (for backward compatibility)
// ============================================================================

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
export function runSiteMiner(options: SiteMinerOptions): Promise<SiteMinerResult> {
  const agentConfig = Config.getAgentConfig();
  const siteMiner = new SiteMiner({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    defaultTimeout: options.timeout,
  });

  return siteMiner.asTool().handler(options);
}

/**
 * Export a factory function for convenience.
 * @deprecated Use `new SiteMiner(config)` instead
 */
export function createSiteMiner(_config?: Partial<BaseAgentConfig>): typeof runSiteMiner {
  // SiteMiner uses global config, but this allows for future customization
  return runSiteMiner;
}
