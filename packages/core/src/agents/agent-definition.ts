/**
 * Agent Definition - Project-level Agent configuration system.
 *
 * Issue #1410: Replace SubagentManager with project-level Agent definitions.
 *
 * This module provides:
 * - AgentDefinition type for `.claude/agents/*.md` files
 * - YAML frontmatter parsing for agent configuration
 * - Support for tools, model, description, and other settings
 *
 * Agent definitions allow configuring agents via Markdown files instead of
 * hardcoding TypeScript code, enabling:
 * - Easy customization without code changes
 * - Git-managed configuration
 * - Per-project agent specialization
 *
 * @example
 * ```markdown
 * ---
 * name: schedule-executor
 * description: Scheduled task execution expert. Execute scheduled tasks autonomously.
 * tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
 * model: sonnet
 * ---
 *
 * You are a scheduled task executor.
 * Execute scheduled tasks autonomously and report results.
 * ```
 *
 * @module agents/agent-definition
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentDefinition');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Available tools for agent definitions.
 * These map to Claude Agent SDK tool names.
 */
export type AgentTool =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Bash'
  | 'Glob'
  | 'Grep'
  | 'WebFetch'
  | 'WebSearch'
  | 'Task'
  | 'NotebookEdit'
  | 'TodoWrite'
  | 'Skill';

/**
 * Agent category for grouping and discovery.
 */
export type AgentCategory =
  | 'general'
  | 'schedule'
  | 'skill'
  | 'task'
  | 'review'
  | 'security'
  | 'analysis';

/**
 * Agent definition parsed from `.claude/agents/*.md` file.
 *
 * @example
 * ```typescript
 * const def: AgentDefinition = {
 *   name: 'schedule-executor',
 *   description: 'Scheduled task execution expert',
 *   tools: ['Read', 'Write', 'Edit', 'Bash'],
 *   model: 'sonnet',
 *   category: 'schedule',
 *   instructions: 'You are a scheduled task executor...',
 *   filePath: '/path/to/.claude/agents/schedule-executor.md',
 * };
 * ```
 */
export interface AgentDefinition {
  /** Unique agent name (from filename or frontmatter) */
  name: string;
  /** Description for auto-delegation matching */
  description: string;
  /** Allowed tools for this agent */
  tools?: AgentTool[];
  /** Model to use (sonnet, opus, haiku, or full model name) */
  model?: string;
  /** Category for grouping */
  category?: AgentCategory;
  /** Run in background mode */
  background?: boolean;
  /** Skills to make available */
  skills?: string[];
  /** Additional configuration options */
  options?: Record<string, unknown>;
  /** Instructions/system prompt content (Markdown body after frontmatter) */
  instructions: string;
  /** Path to the definition file */
  filePath: string;
}

/**
 * YAML frontmatter configuration.
 * This is the raw structure parsed from the frontmatter.
 */
export interface AgentFrontmatter {
  name?: string;
  description?: string;
  tools?: AgentTool[];
  model?: string;
  category?: AgentCategory;
  background?: boolean;
  skills?: string[];
  options?: Record<string, unknown>;
}

/**
 * Discovered agent definition with metadata.
 */
export interface DiscoveredAgent {
  /** Agent definition */
  definition: AgentDefinition;
  /** Domain where the agent was found */
  domain: 'project' | 'workspace' | 'user';
  /** Priority (higher = preferred when duplicates exist) */
  priority: number;
}

/**
 * Search path configuration for agent discovery.
 */
export interface AgentSearchPath {
  /** Directory path to search */
  path: string;
  /** Domain identifier */
  domain: 'project' | 'workspace' | 'user';
  /** Priority (higher = searched first) */
  priority: number;
}

// ============================================================================
// YAML Frontmatter Parsing
// ============================================================================

/**
 * Parse YAML frontmatter from Markdown content.
 *
 * Supports simple YAML syntax:
 * - key: value
 * - key: [array, values]
 * - key: "string with spaces"
 *
 * @param content - Raw Markdown content
 * @returns Tuple of [frontmatter, bodyContent]
 *
 * @example
 * ```typescript
 * const content = `---
 * name: my-agent
 * tools: ["Read", "Write"]
 * ---
 * Instructions here`;
 *
 * const [frontmatter, body] = parseFrontmatter(content);
 * // frontmatter = { name: 'my-agent', tools: ['Read', 'Write'] }
 * // body = 'Instructions here'
 * ```
 */
export function parseFrontmatter(content: string): [AgentFrontmatter, string] {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n?---\s*\n?([\s\S]*)?$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    // No frontmatter, return empty frontmatter and full content as body
    return [{}, content];
  }

  const [, frontmatterStr, body = ''] = match;
  const frontmatter: AgentFrontmatter = {};

  // Simple YAML parser for flat structure
  const lines = frontmatterStr.split('\n');
  let currentKey: string | null = null;
  let arrayValues: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      continue;
    }

    // Check if this is an array item
    if (trimmed.startsWith('- ') && currentKey) {
      const value = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
      arrayValues.push(value);
      continue;
    }

    // Save previous array if any
    if (currentKey && arrayValues.length > 0) {
      (frontmatter as Record<string, unknown>)[currentKey] = arrayValues;
      arrayValues = [];
    }

    // Check for key: value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      currentKey = null;
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    currentKey = key;

    // Handle array syntax: key: [value1, value2]
    if (value.startsWith('[') && value.endsWith(']')) {
      const arrayContent = value.slice(1, -1);
      const items = arrayContent
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter((item) => item.length > 0);
      (frontmatter as Record<string, unknown>)[key] = items;
      currentKey = null;
      continue;
    }

    // Handle empty value (might be array on next lines)
    if (!value) {
      arrayValues = [];
      continue;
    }

    // Handle string value
    value = value.replace(/^["']|["']$/g, '');

    // Handle boolean
    if (value === 'true') {
      (frontmatter as Record<string, unknown>)[key] = true;
    } else if (value === 'false') {
      (frontmatter as Record<string, unknown>)[key] = false;
    } else {
      (frontmatter as Record<string, unknown>)[key] = value;
    }

    currentKey = null;
  }

  // Save last array if any
  if (currentKey && arrayValues.length > 0) {
    (frontmatter as Record<string, unknown>)[currentKey] = arrayValues;
  }

  return [frontmatter, body.trim()];
}

// ============================================================================
// Agent Definition Loading
// ============================================================================

/**
 * Load and parse an agent definition from a file.
 *
 * @param filePath - Path to the agent definition file
 * @returns Parsed agent definition
 * @throws Error if file cannot be read or parsed
 *
 * @example
 * ```typescript
 * const def = await loadAgentDefinition('/path/to/.claude/agents/schedule-executor.md');
 * console.log(def.name, def.tools);
 * ```
 */
export async function loadAgentDefinition(filePath: string): Promise<AgentDefinition> {
  const content = await fs.readFile(filePath, 'utf-8');
  const [frontmatter, instructions] = parseFrontmatter(content);

  // Derive name from filename if not in frontmatter
  const fileName = path.basename(filePath, '.md');

  const definition: AgentDefinition = {
    name: frontmatter.name || fileName,
    description: frontmatter.description || '',
    tools: frontmatter.tools,
    model: frontmatter.model,
    category: frontmatter.category,
    background: frontmatter.background,
    skills: frontmatter.skills,
    options: frontmatter.options,
    instructions,
    filePath,
  };

  logger.debug({ name: definition.name, path: filePath }, 'Loaded agent definition');

  return definition;
}

/**
 * Get default search paths for agent definitions.
 *
 * Search order (higher priority first):
 * 1. Project domain: `.claude/agents/` in current working directory
 * 2. Workspace domain: `.claude/agents/` in configured workspace
 * 3. User domain: `~/.claude/agents/` in user home directory
 *
 * @returns Array of search paths sorted by priority
 */
export function getDefaultAgentSearchPaths(): AgentSearchPath[] {
  const cwd = process.cwd();
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  // We'll get workspace from Config if available, otherwise use cwd
  let workspaceDir = cwd;
  try {
    // Dynamic import to avoid circular dependency
    const { Config } = require('../config/index.js');
    workspaceDir = Config.getWorkspaceDir();
  } catch {
    // Config not available, use cwd
  }

  const paths: AgentSearchPath[] = [
    // Project domain - highest priority
    { path: path.join(cwd, '.claude', 'agents'), domain: 'project', priority: 30 },

    // Workspace domain - medium priority
    { path: path.join(workspaceDir, '.claude', 'agents'), domain: 'workspace', priority: 20 },

    // User domain - lowest priority
    { path: path.join(homeDir, '.claude', 'agents'), domain: 'user', priority: 10 },
  ];

  return paths.sort((a, b) => b.priority - a.priority);
}

/**
 * Find an agent definition by name.
 *
 * Searches all paths and returns the highest priority match.
 *
 * @param name - Agent name to find
 * @param searchPaths - Optional custom search paths
 * @returns Agent definition or null if not found
 *
 * @example
 * ```typescript
 * const def = await findAgentDefinition('schedule-executor');
 * if (def) {
 *   console.log(`Found: ${def.description}`);
 * }
 * ```
 */
export async function findAgentDefinition(
  name: string,
  searchPaths?: AgentSearchPath[]
): Promise<AgentDefinition | null> {
  // Sort paths by priority (descending) to ensure higher priority paths are searched first
  const paths = (searchPaths || getDefaultAgentSearchPaths()).sort((a, b) => b.priority - a.priority);

  for (const searchPath of paths) {
    const agentFile = path.join(searchPath.path, `${name}.md`);

    try {
      await fs.access(agentFile);
      const definition = await loadAgentDefinition(agentFile);
      logger.debug({ name, path: agentFile, domain: searchPath.domain }, 'Found agent definition');
      return definition;
    } catch {
      // Continue to next search path
    }
  }

  logger.debug({ name }, 'Agent definition not found');
  return null;
}

/**
 * List all available agent definitions.
 *
 * Discovers all agents and returns them grouped by name.
 * If the same agent exists in multiple domains, only the
 * highest priority version is returned.
 *
 * @param searchPaths - Optional custom search paths
 * @returns Array of discovered agents
 *
 * @example
 * ```typescript
 * const agents = await listAgentDefinitions();
 * for (const agent of agents) {
 *   console.log(`${agent.definition.name}: ${agent.definition.description}`);
 * }
 * ```
 */
export async function listAgentDefinitions(
  searchPaths?: AgentSearchPath[]
): Promise<DiscoveredAgent[]> {
  const paths = (searchPaths || getDefaultAgentSearchPaths()).sort((a, b) => b.priority - a.priority);
  const found = new Map<string, DiscoveredAgent>();

  for (const searchPath of paths) {
    try {
      const entries = await fs.readdir(searchPath.path, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) {
          continue;
        }

        const agentName = path.basename(entry.name, '.md');
        const agentFile = path.join(searchPath.path, entry.name);

        try {
          // Only add if not already found (higher priority wins)
          if (!found.has(agentName)) {
            const definition = await loadAgentDefinition(agentFile);
            found.set(agentName, {
              definition,
              domain: searchPath.domain,
              priority: searchPath.priority,
            });
          }
        } catch (error) {
          logger.warn({ file: agentFile, error }, 'Failed to load agent definition');
        }
      }
    } catch {
      // Search path doesn't exist or not readable, skip
    }
  }

  const agents = Array.from(found.values());
  logger.debug({ count: agents.length, agents: agents.map((a) => a.definition.name) }, 'Listed agent definitions');

  return agents;
}

/**
 * Check if an agent definition exists.
 *
 * @param name - Agent name to check
 * @param searchPaths - Optional custom search paths
 * @returns True if agent exists
 */
export async function agentDefinitionExists(
  name: string,
  searchPaths?: AgentSearchPath[]
): Promise<boolean> {
  const definition = await findAgentDefinition(name, searchPaths);
  return definition !== null;
}
