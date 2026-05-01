/**
 * Third-party API Adapter for Claude-compatible endpoints (Issue #2948)
 *
 * When using third-party Claude-compatible API endpoints (e.g., GLM/智谱),
 * the Claude Agent SDK embeds system tool definitions in the system prompt
 * (XML format) rather than via the `tools` API parameter. These third-party
 * endpoints only recognize the `tools` parameter, causing all system tools
 * (Bash, Read, Write, Edit, Glob, Grep, etc.) to be unavailable.
 *
 * This module provides:
 * 1. Tool extraction from the system prompt XML format
 * 2. Conversion to the `tools` API parameter format
 * 3. Injection into the API request body
 *
 * Architecture:
 *   CLI subprocess → local proxy → extract tools from system prompt → inject as `tools` param → actual API (GLM)
 *
 * @module third-party-adapter
 */

import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('ThirdPartyToolAdapter');

// ============================================================================
// Types
// ============================================================================

/**
 * Tool definition in Anthropic API `tools` parameter format.
 */
export interface ApiToolDefinition {
  /** Tool name (e.g., "Bash", "Read") */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for tool input parameters */
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * Result of tool extraction from a system prompt.
 */
export interface ToolExtractionResult {
  /** Extracted tool definitions */
  tools: ApiToolDefinition[];
  /** Whether any tools were found */
  found: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Regex patterns for extracting tool definitions from system prompts.
 *
 * The Claude Code CLI embeds tool definitions in the system prompt using
 * several possible XML formats. We support multiple patterns for robustness.
 */
const TOOL_PATTERNS = [
  // Pattern 1: <functions><function>{"name":...}</function></functions>
  // Each <function> tag contains a JSON object
  {
    // Match the entire <functions> block
    blockRegex: /<functions>([\s\S]*?)<\/functions>/g,
    // Match individual <function> tags
    itemRegex: /<function>([\s\S]*?)<\/function>/g,
    format: 'functions' as const,
  },
  // Pattern 2: <available_tools><tool>{"name":...}</tool></available_tools>
  {
    blockRegex: /<available_tools>([\s\S]*?)<\/available_tools>/g,
    itemRegex: /<tool>([\s\S]*?)<\/tool>/g,
    format: 'available_tools' as const,
  },
];

// (Constants TOOL_DEFINITION_REQUIRED_FIELDS and TOOL_DEFINITION_ALT_FIELDS
// are reserved for future validation enhancements.)

// ============================================================================
// Tool Extraction
// ============================================================================

/**
 * Extract tool definitions from a system prompt string.
 *
 * Searches for XML-embedded tool definitions in various formats and converts
 * them to the Anthropic API `tools` parameter format.
 *
 * @param systemPrompt - The system prompt text to search
 * @returns Extraction result with tool definitions
 */
export function extractToolsFromSystemPrompt(systemPrompt: string): ToolExtractionResult {
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return { tools: [], found: false };
  }

  const tools: ApiToolDefinition[] = [];

  for (const pattern of TOOL_PATTERNS) {
    let blockMatch: RegExpExecArray | null;
    pattern.blockRegex.lastIndex = 0;

    while ((blockMatch = pattern.blockRegex.exec(systemPrompt)) !== null) {
      const [, blockContent] = blockMatch;
      let itemMatch: RegExpExecArray | null;
      pattern.itemRegex.lastIndex = 0;

      while ((itemMatch = pattern.itemRegex.exec(blockContent)) !== null) {
        const itemContent = itemMatch[1].trim();
        const tool = parseToolDefinition(itemContent);
        if (tool) {
          tools.push(tool);
        }
      }
    }

    // If we found tools with this pattern, no need to try others
    if (tools.length > 0) {
      break;
    }
  }

  // Fallback: try to find JSON tool definitions directly in the text
  // (handles cases where XML wrapping is missing or different)
  if (tools.length === 0) {
    const fallbackTools = extractToolsFromJsonArray(systemPrompt);
    tools.push(...fallbackTools);
  }

  if (tools.length > 0) {
    logger.info(
      { toolCount: tools.length, toolNames: tools.map(t => t.name) },
      'Extracted tool definitions from system prompt'
    );
  } else {
    logger.debug('No tool definitions found in system prompt');
  }

  return { tools, found: tools.length > 0 };
}

/**
 * Parse a single tool definition from a string (expected to be JSON).
 *
 * Handles both the standard format (with `parameters`) and the
 * Anthropic API format (with `input_schema`).
 *
 * @param content - JSON string containing a tool definition
 * @returns Parsed tool definition or null if invalid
 */
function parseToolDefinition(content: string): ApiToolDefinition | null {
  try {
    const obj = JSON.parse(content);

    // Validate required fields
    if (!obj.name || typeof obj.name !== 'string') {
      return null;
    }
    if (!obj.description || typeof obj.description !== 'string') {
      return null;
    }

    // Handle both `parameters` and `input_schema` field names
    const schema = obj.parameters || obj.input_schema;
    if (!schema || typeof schema !== 'object') {
      return null;
    }

    return {
      name: obj.name,
      description: obj.description,
      input_schema: {
        type: schema.type || 'object',
        properties: schema.properties || {},
        required: schema.required || [],
        ...(schema.additionalProperties !== undefined
          ? { additionalProperties: schema.additionalProperties }
          : {}),
      },
    };
  } catch {
    // Not valid JSON, skip
    logger.debug({ contentPreview: content.slice(0, 100) }, 'Failed to parse tool definition as JSON');
    return null;
  }
}

/**
 * Fallback: Extract tool definitions from JSON array in the text.
 *
 * Looks for JSON arrays containing objects with name/description/parameters fields.
 *
 * @param text - Text to search
 * @returns Extracted tool definitions
 */
function extractToolsFromJsonArray(text: string): ApiToolDefinition[] {
  const tools: ApiToolDefinition[] = [];

  // Look for JSON arrays that might contain tool definitions
  // Match patterns like: [{"name": "...", "description": "...", "parameters": {...}}, ...]
  const jsonArrayRegex = /\[\s*\{[\s\S]*?"name"\s*:\s*"[^"]*"[\s\S]*?"description"\s*:[\s\S]*?\}\s*\]/g;

  let match: RegExpExecArray | null;
  while ((match = jsonArrayRegex.exec(text)) !== null) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (
            typeof item === 'object' &&
            item !== null &&
            typeof item.name === 'string' &&
            typeof item.description === 'string'
          ) {
            const schema = item.parameters || item.input_schema;
            if (schema && typeof schema === 'object') {
              tools.push({
                name: item.name,
                description: item.description,
                input_schema: {
                  type: schema.type || 'object',
                  properties: schema.properties || {},
                  required: schema.required || [],
                },
              });
            }
          }
        }
      }
    } catch {
      // Not valid JSON array, skip
    }

    // Limit to prevent excessive processing
    if (tools.length >= 50) {
      break;
    }
  }

  return tools;
}

// ============================================================================
// Request Body Transformation
// ============================================================================

/**
 * API request body structure (simplified).
 */
interface ApiRequestBody {
  model?: string;
  system?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  messages?: unknown[];
  tools?: ApiToolDefinition[];
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

/**
 * Transform an API request body to include extracted tools.
 *
 * This function:
 * 1. Parses the request body JSON
 * 2. Extracts tool definitions from the system prompt
 * 3. Adds them to the `tools` parameter (merging with existing tools)
 * 4. Returns the modified request body
 *
 * @param body - The original request body (JSON string)
 * @returns Modified request body with tools injected
 */
export function transformRequestBodyForThirdParty(body: string): string {
  try {
    const parsed: ApiRequestBody = JSON.parse(body);

    // Extract system prompt text
    const systemText = extractSystemText(parsed.system);
    if (!systemText) {
      logger.debug('No system prompt found in request body, skipping tool extraction');
      return body;
    }

    // Extract tool definitions
    const { tools: extractedTools, found } = extractToolsFromSystemPrompt(systemText);
    if (!found || extractedTools.length === 0) {
      logger.debug('No tools to inject');
      return body;
    }

    // Merge with existing tools (if any)
    const existingTools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const existingNames = new Set(existingTools.map(t => t.name));

    // Only add tools that aren't already in the `tools` parameter
    const newTools = extractedTools.filter(t => !existingNames.has(t.name));
    if (newTools.length === 0) {
      logger.debug('All extracted tools already present in tools parameter');
      return body;
    }

    // Set the tools parameter
    parsed.tools = [...existingTools, ...newTools];

    logger.info(
      {
        existingToolCount: existingTools.length,
        newToolCount: newTools.length,
        totalToolCount: parsed.tools.length,
        newToolNames: newTools.map(t => t.name),
      },
      'Injected extracted tool definitions into API request'
    );

    return JSON.stringify(parsed);
  } catch (error) {
    logger.warn(
      { err: error },
      'Failed to transform request body for third-party API — forwarding original body'
    );
    return body;
  }
}

/**
 * Extract text content from a system prompt field.
 *
 * The `system` field in the Anthropic API can be either:
 * - A string
 * - An array of content blocks with type "text"
 *
 * @param system - The system prompt field
 * @returns Concatenated text content
 */
function extractSystemText(
  system: ApiRequestBody['system']
): string {
  if (!system) {
    return '';
  }

  if (typeof system === 'string') {
    return system;
  }

  if (Array.isArray(system)) {
    return system
      .filter((block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        block.type === 'text' &&
        typeof block.text === 'string'
      )
      .map(block => block.text)
      .join('\n');
  }

  return '';
}
