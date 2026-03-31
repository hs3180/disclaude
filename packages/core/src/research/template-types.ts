/**
 * Template type definitions for the research report rendering system.
 *
 * Issue #1339: Agentic Research - Template rendering for research reports.
 *
 * Template syntax:
 * - `{{variable}}` — Simple variable substitution
 * - `{{#section}}...{{/section}}` — Conditional section (renders only if variable is truthy)
 * - `{{#each items}}...{{/each}}` — List iteration (items must be an array)
 * - `{{#if condition}}...{{/if}}` — Conditional rendering
 *
 * @module @disclaude/core/research
 */

/**
 * A template variable definition with metadata.
 */
export interface TemplateVariable {
  /** Variable name (used in template as `{{name}}`) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Variable type */
  type: 'string' | 'string[]' | 'number' | 'boolean' | 'date' | 'object';
  /** Whether the variable is required */
  required: boolean;
  /** Default value if not provided */
  defaultValue?: unknown;
}

/**
 * Built-in template type identifiers.
 */
export type BuiltinTemplateType = 'summary' | 'detailed' | 'technical' | 'briefing';

/**
 * A report template definition.
 */
export interface ReportTemplate {
  /** Template identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Template description */
  description: string;
  /** Template format (markdown is the default and only supported format) */
  format: 'markdown';
  /** Template content with `{{variable}}` placeholders */
  content: string;
  /** Variable definitions used by this template */
  variables: TemplateVariable[];
  /** Tags for template discovery/filtering */
  tags: string[];
}

/**
 * Template rendering context — maps template variable names to values.
 */
export type RenderContext = Record<string, unknown>;

/**
 * Result of a template rendering operation.
 */
export interface RenderResult {
  /** Rendered markdown content */
  content: string;
  /** Template ID used for rendering */
  templateId: string;
  /** Rendering timestamp (ISO string) */
  renderedAt: string;
  /** Variables that were not found in the template (informational) */
  unusedVariables: string[];
  /** Required variables that were missing from the context */
  missingVariables: string[];
}

/**
 * Options for the template renderer.
 */
export interface RendererOptions {
  /** Custom templates directory (loaded in addition to built-in templates) */
  templatesDir?: string;
  /** Maximum rendered content size in bytes (default: 64KB) */
  maxSizeBytes?: number;
}
