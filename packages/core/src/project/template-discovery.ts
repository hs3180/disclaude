/**
 * Template auto-discovery module.
 *
 * Scans multiple search paths to discover available project templates
 * from the filesystem, eliminating the need for manual configuration in
 * disclaude.config.yaml.
 *
 * Template discovery rules:
 * - Scan each search path's `templates/` subdirectory for template directories
 * - Each subdirectory containing a `CLAUDE.md` file is a valid template
 * - Template name = directory name
 * - Metadata (displayName, description) read from `template.yaml` or
 *   CLAUDE.md YAML frontmatter
 * - When the same template name exists in multiple paths, the highest
 *   priority path wins (like Skills auto-discovery)
 *
 * Search path priority (highest first):
 * 1. Project domain: `{cwd}/templates/` (user's custom templates)
 * 2. Workspace domain: `{workspace}/.claude/templates/` (workspace templates)
 * 3. Package domain: `{packageDir}/templates/` (built-in templates)
 *
 * @see Issue #2286 — Project templates should auto-discover from package directory
 * @see Issue #1916 (parent)
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ProjectTemplate, ProjectTemplatesConfig } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Default subdirectory name for templates under packageDir */
const TEMPLATES_DIR_NAME = 'templates';

/** Required file for a template directory to be considered valid */
const REQUIRED_TEMPLATE_FILE = 'CLAUDE.md';

/** Optional metadata file */
const TEMPLATE_META_FILE = 'template.yaml';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Result of template discovery operation.
 */
export interface DiscoveryResult {
  /** All discovered templates */
  templates: ProjectTemplate[];
  /** Any errors encountered during discovery (non-fatal) */
  errors: DiscoveryError[];
}

/**
 * Non-fatal error during template discovery.
 */
export interface DiscoveryError {
  /** Directory name where the error occurred */
  dirName: string;
  /** Human-readable error description */
  message: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Search Path Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Search path configuration for template discovery.
 *
 * Mirrors the Skills finder pattern — multiple domains with priority-based resolution.
 */
export interface TemplateSearchPath {
  /** Absolute directory path to scan for template subdirectories */
  path: string;
  /** Domain identifier for logging and debugging */
  domain: 'project' | 'workspace' | 'package';
  /** Priority (higher = wins when same template name exists in multiple paths) */
  priority: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Discovery Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for template discovery.
 */
export interface DiscoveryOptions {
  /** Custom templates directory name (default: 'templates') */
  templatesDirName?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Metadata Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Template metadata from template.yaml or CLAUDE.md frontmatter.
 */
interface TemplateMetadata {
  displayName?: string;
  description?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Public API — Single-path Discovery
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Discover project templates from the filesystem.
 *
 * Scans `{packageDir}/templates/` for subdirectories containing `CLAUDE.md`.
 * Returns discovered templates and any non-fatal errors.
 *
 * If the templates directory doesn't exist, returns an empty result (no error).
 * This allows the system to work without any templates installed.
 *
 * @param packageDir - The package root directory containing a `templates/` subdirectory
 * @param options - Optional configuration for discovery behavior
 * @returns Discovery result with templates and errors
 *
 * @example
 * ```typescript
 * const result = discoverTemplates('/app/packages/core');
 * // result.templates: [{ name: 'research', displayName: '研究模式', ... }]
 * // result.errors: []
 *
 * // Convert to config format for ProjectManager.init()
 * const config = discoveryResultToConfig(result);
 * projectManager.init(config);
 * ```
 */
export function discoverTemplates(
  packageDir: string,
  options?: DiscoveryOptions,
): DiscoveryResult {
  const templatesDir = path.join(packageDir, options?.templatesDirName ?? TEMPLATES_DIR_NAME);
  const templates: ProjectTemplate[] = [];
  const errors: DiscoveryError[] = [];

  // Templates directory doesn't exist — not an error, just no templates
  if (!fs.existsSync(templatesDir)) {
    return { templates, errors };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(templatesDir, { withFileTypes: true });
  } catch (err) {
    errors.push({
      dirName: TEMPLATES_DIR_NAME,
      message: `Failed to read templates directory: ${(err as Error).message}`,
    });
    return { templates, errors };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dirName = entry.name;
    const templateDir = path.join(templatesDir, dirName);
    const claudeMdPath = path.join(templateDir, REQUIRED_TEMPLATE_FILE);

    // Skip directories without CLAUDE.md
    if (!fs.existsSync(claudeMdPath)) {
      continue;
    }

    // Validate directory name (same rules as instance names)
    if (!isValidTemplateName(dirName)) {
      errors.push({
        dirName,
        message: `Invalid template directory name: "${dirName}" (must be non-empty, no path traversal characters, ≤ 64 chars)`,
      });
      continue;
    }

    // Read metadata
    const metadata = readTemplateMetadata(templateDir, errors);

    templates.push({
      name: dirName,
      displayName: metadata.displayName,
      description: metadata.description,
    });
  }

  return { templates, errors };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Public API — Multi-path Discovery
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Build default template search paths following the Skills auto-discovery pattern.
 *
 * Search order (higher priority first):
 * 1. **Project domain**: `{cwd}/templates/` — user's custom project templates
 * 2. **Workspace domain**: `{workspace}/.claude/templates/` — shared workspace templates
 * 3. **Package domain**: `{packageDir}/templates/` — built-in templates shipped with the package
 *
 * @param cwd - Current working directory (defaults to `process.cwd()`)
 * @param workspaceDir - Workspace root directory
 * @param packageDir - Package installation directory (built-in templates)
 * @returns Array of search paths sorted by priority (highest first)
 *
 * @example
 * ```typescript
 * const paths = getDefaultTemplateSearchPaths({
 *   cwd: process.cwd(),
 *   workspaceDir: Config.getWorkspaceDir(),
 *   packageDir: Config.getTemplatesDir(),
 * });
 * // Returns:
 * // [
 * //   { path: '/project/templates', domain: 'project', priority: 3 },
 * //   { path: '/workspace/.claude/templates', domain: 'workspace', priority: 2 },
 * //   { path: '/app/templates', domain: 'package', priority: 1 },
 * // ]
 * ```
 */
export function getDefaultTemplateSearchPaths(options: {
  cwd: string;
  workspaceDir: string;
  packageDir: string;
}): TemplateSearchPath[] {
  const paths: TemplateSearchPath[] = [
    // Project domain — highest priority (user's custom templates)
    { path: options.cwd, domain: 'project', priority: 3 },

    // Workspace domain — medium priority (shared across projects)
    { path: path.join(options.workspaceDir, '.claude'), domain: 'workspace', priority: 2 },

    // Package domain — lowest priority (built-in templates)
    { path: options.packageDir, domain: 'package', priority: 1 },
  ];

  return paths.sort((a, b) => b.priority - a.priority);
}

/**
 * Discover templates from multiple search paths with priority-based deduplication.
 *
 * Scans each search path for template directories. When the same template name
 * exists in multiple paths, the one from the highest-priority path wins.
 *
 * This mirrors the Skills auto-discovery pattern: project overrides workspace,
 * workspace overrides package.
 *
 * @param searchPaths - Array of search paths (should be sorted by priority, highest first)
 * @returns Discovery result with deduplicated templates and accumulated errors
 *
 * @example
 * ```typescript
 * const paths = getDefaultTemplateSearchPaths({ cwd, workspaceDir, packageDir });
 * const result = discoverTemplatesFromPaths(paths);
 * // result.templates: unique templates, highest priority wins
 * ```
 */
export function discoverTemplatesFromPaths(searchPaths: TemplateSearchPath[]): DiscoveryResult {
  const found = new Map<string, ProjectTemplate>();
  const errors: DiscoveryError[] = [];

  for (const searchPath of searchPaths) {
    const result = discoverTemplates(searchPath.path);
    errors.push(...result.errors);

    for (const template of result.templates) {
      // Only add if not already found (higher priority wins)
      if (!found.has(template.name)) {
        found.set(template.name, template);
      }
    }
  }

  return {
    templates: Array.from(found.values()),
    errors,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Public API — Config Conversion
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Convert a discovery result to ProjectTemplatesConfig format.
 *
 * This allows discovered templates to be passed directly to
 * `ProjectManager.init(templatesConfig)`.
 *
 * @param result - Discovery result from `discoverTemplates()`
 * @returns ProjectTemplatesConfig compatible with ProjectManager
 */
export function discoveryResultToConfig(result: DiscoveryResult): ProjectTemplatesConfig {
  const config: ProjectTemplatesConfig = {};
  for (const template of result.templates) {
    config[template.name] = {
      displayName: template.displayName,
      description: template.description,
    };
  }
  return config;
}

/**
 * Discover templates and return directly as ProjectTemplatesConfig.
 *
 * Convenience function combining `discoverTemplates()` and `discoveryResultToConfig()`.
 * Errors are silently ignored — use `discoverTemplates()` directly if you need
 * error details.
 *
 * @param packageDir - The package root directory
 * @returns ProjectTemplatesConfig from discovered templates
 */
export function discoverTemplatesAsConfig(packageDir: string): ProjectTemplatesConfig {
  return discoveryResultToConfig(discoverTemplates(packageDir));
}

/**
 * Discover templates from multiple paths and return as ProjectTemplatesConfig.
 *
 * Convenience function combining `discoverTemplatesFromPaths()` and `discoveryResultToConfig()`.
 * Errors are silently ignored.
 *
 * @param searchPaths - Array of search paths
 * @returns ProjectTemplatesConfig from discovered templates
 */
export function discoverTemplatesFromPathsAsConfig(searchPaths: TemplateSearchPath[]): ProjectTemplatesConfig {
  return discoveryResultToConfig(discoverTemplatesFromPaths(searchPaths));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Private Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Characters forbidden in template directory names */
const FORBIDDEN_NAME_CHARS = /[\x00\\/]/;

/**
 * Validate a template directory name.
 *
 * Rules:
 * - Must be non-empty
 * - Must not be "default" (reserved)
 * - Must not contain ".." (path traversal)
 * - Must not contain "/" or "\" (path separators)
 * - Must not contain null bytes
 * - Must not exceed 64 characters
 */
function isValidTemplateName(name: string): boolean {
  if (!name || name.length === 0) {
    return false;
  }
  if (name === 'default') {
    return false;
  }
  if (name === '..' || name.includes('..')) {
    return false;
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    return false;
  }
  if (name.trim().length === 0) {
    return false;
  }
  if (name.length > 64) {
    return false;
  }
  return true;
}

/**
 * Read template metadata from template.yaml or CLAUDE.md frontmatter.
 *
 * Priority: template.yaml > CLAUDE.md frontmatter
 */
function readTemplateMetadata(
  templateDir: string,
  errors: DiscoveryError[],
): TemplateMetadata {
  const dirName = path.basename(templateDir);

  // Try template.yaml first
  const yamlPath = path.join(templateDir, TEMPLATE_META_FILE);
  if (fs.existsSync(yamlPath)) {
    try {
      const content = fs.readFileSync(yamlPath, 'utf-8');
      const metadata = parseSimpleYaml(content);
      if (metadata && (metadata.displayName || metadata.description)) {
        return metadata;
      }
    } catch (err) {
      errors.push({
        dirName,
        message: `Failed to read template.yaml: ${(err as Error).message}`,
      });
    }
  }

  // Try CLAUDE.md frontmatter
  const claudeMdPath = path.join(templateDir, REQUIRED_TEMPLATE_FILE);
  try {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const frontmatter = extractYamlFrontmatter(content);
    if (frontmatter) {
      return parseSimpleYaml(frontmatter) ?? {};
    }
  } catch {
    // CLAUDE.md already verified to exist, but reading might still fail
    errors.push({
      dirName,
      message: 'Failed to read CLAUDE.md for metadata',
    });
  }

  return {};
}

/**
 * Extract YAML frontmatter from a markdown file.
 *
 * Frontmatter is enclosed between `---` delimiters at the start of the file.
 *
 * @returns The frontmatter content (between the delimiters), or undefined
 */
function extractYamlFrontmatter(content: string): string | undefined {
  if (!content.startsWith('---')) {
    return undefined;
  }

  const endDelimiter = content.indexOf('---', 3);
  if (endDelimiter === -1) {
    return undefined;
  }

  return content.slice(3, endDelimiter).trim();
}

/**
 * Parse a simple YAML subset (key: value pairs only).
 *
 * Supports single-level string values:
 * ```yaml
 * displayName: "研究模式"
 * description: A research workspace
 * ```
 *
 * This is intentionally minimal — template metadata only needs simple key-value pairs.
 * For complex YAML, users should use a proper YAML parser.
 */
function parseSimpleYaml(content: string): TemplateMetadata | null {
  const result: TemplateMetadata = {};
  let found = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key === 'displayName') {
      result.displayName = value;
      found = true;
    } else if (key === 'description') {
      result.description = value;
      found = true;
    }
  }

  return found ? result : null;
}
