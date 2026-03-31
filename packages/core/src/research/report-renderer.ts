/**
 * Research Report Renderer - Template-based report rendering engine.
 *
 * Issue #1339: Agentic Research - Template rendering for research reports.
 *
 * Supports template syntax:
 * - `{{variable}}` — Simple variable substitution
 * - `{{variable.property}}` — Nested property access
 * - `{{#section}}...{{/section}}` — Conditional section (truthy check)
 * - `{{#if condition}}...{{/if}}` — Conditional rendering
 * - `{{#each items}}...{{/each}}` — List iteration with `{{this}}` and `{{index}}`
 *
 * Design principles:
 * - Zero dependencies: Pure string processing, no external template libraries
 * - Fail-safe: Missing variables produce empty strings, not errors
 * - Composable: Built-in templates can be extended or overridden via files
 * - Size-limited: Maximum output size to prevent token waste
 *
 * @module @disclaude/core/research
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ResearchReport } from './types.js';
import type {
  ReportTemplate,
  RenderContext,
  RenderResult,
  RendererOptions,
} from './template-types.js';
import {
  getBuiltinTemplate,
  getAllBuiltinTemplates,
} from './builtin-templates.js';

const logger = createLogger('ReportRenderer');

/** Default maximum rendered content size (64KB) */
const DEFAULT_MAX_SIZE_BYTES = 64 * 1024;

/** Regex pattern for variable placeholders: {{name}} or {{name.property}} */
const VARIABLE_PATTERN = /\{\{([^#/][^}]*)\}\}/g;

/** Regex pattern for conditional sections: {{#if condition}}...{{/if}} */
const CONDITIONAL_PATTERN = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g;

/** Regex pattern for conditional sections (truthy): {{#section}}...{{/section}} */
const SECTION_PATTERN = /\{\{#(\w+(?:\.\w+)*)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

/** Regex pattern for list iteration: {{#each items}}...{{/each}} */
const EACH_PATTERN = /\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;

/** Regex pattern for `{{this}}` inside each blocks */
const THIS_PATTERN = /\{\{this\}\}/g;

/** Regex pattern for `{{index}}` inside each blocks */
const INDEX_PATTERN = /\{\{index\}\}/g;

/**
 * Research Report Renderer.
 *
 * Renders research reports using templates with variable substitution,
 * conditional sections, and list iteration.
 *
 * Usage:
 * ```typescript
 * const renderer = new ReportRenderer();
 *
 * // Render with a built-in template
 * const result = renderer.render('summary', report);
 *
 * // Render with a custom template
 * const result = renderer.renderTemplate(myTemplate, report);
 * ```
 */
export class ReportRenderer {
  private readonly maxSizeBytes: number;
  private readonly customTemplates: Map<string, ReportTemplate> = new Map();
  private templatesLoaded = false;
  private templatesDir?: string;

  /**
   * Create a ReportRenderer.
   *
   * @param options - Renderer configuration options
   */
  constructor(options?: RendererOptions) {
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    this.templatesDir = options?.templatesDir;
  }

  /**
   * List all available template IDs (built-in + custom).
   *
   * @returns Array of template IDs
   */
  listTemplates(): string[] {
    const builtins = getAllBuiltinTemplates().map((t) => t.id);
    const customs = Array.from(this.customTemplates.keys());
    return [...builtins, ...customs];
  }

  /**
   * Get a template by ID (checks built-in first, then custom).
   *
   * @param id - Template ID
   * @returns The template, or undefined if not found
   */
  getTemplate(id: string): ReportTemplate | undefined {
    // Check built-in templates first
    const builtin = getBuiltinTemplate(id as 'summary' | 'detailed' | 'technical' | 'briefing');
    if (builtin) return builtin;

    // Check custom templates
    return this.customTemplates.get(id);
  }

  /**
   * Load custom templates from the configured directory.
   *
   * Template files should be markdown files with YAML frontmatter:
   * ```markdown
   * ---
   * id: my-template
   * name: My Template
   * description: A custom template
   * tags: [custom, report]
   * ---
   * Template content with {{variable}} placeholders...
   * ```
   *
   * @returns Array of loaded template IDs
   */
  async loadCustomTemplates(): Promise<string[]> {
    if (!this.templatesDir) {
      return [];
    }

    if (this.templatesLoaded) {
      return Array.from(this.customTemplates.keys());
    }

    try {
      const files = await fs.readdir(this.templatesDir);
      const loaded: string[] = [];

      for (const file of files) {
        if (!file.endsWith('.md') && !file.endsWith('.markdown')) {
          continue;
        }

        try {
          const filePath = path.join(this.templatesDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const template = this.parseTemplateFile(content);

          if (template) {
            this.customTemplates.set(template.id, template);
            loaded.push(template.id);
            logger.debug({ templateId: template.id, file }, 'Custom template loaded');
          }
        } catch (error) {
          logger.warn({ file, err: error }, 'Failed to load custom template file');
        }
      }

      this.templatesLoaded = true;
      logger.info({ count: loaded.length, dir: this.templatesDir }, 'Custom templates loaded');
      return loaded;
    } catch (error) {
      logger.warn({ dir: this.templatesDir, err: error }, 'Failed to read templates directory');
      return [];
    }
  }

  /**
   * Render a research report using a template by ID.
   *
   * @param templateId - Template ID (built-in or custom)
   * @param report - Research report data
   * @returns Render result with content and metadata
   * @throws Error if template not found
   */
  render(templateId: string, report: ResearchReport): RenderResult {
    const template = this.getTemplate(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}. Available: ${this.listTemplates().join(', ')}`);
    }

    return this.renderTemplate(template, report);
  }

  /**
   * Render a research report using a template object.
   *
   * @param template - Template definition
   * @param report - Research report data
   * @returns Render result with content and metadata
   */
  renderTemplate(template: ReportTemplate, report: ResearchReport): RenderResult {
    const context = this.reportToContext(report);
    const content = this.renderContent(template.content, context);
    const missingVariables = this.findMissingVariables(template, context);
    const unusedVariables = this.findUnusedVariables(template, context);

    // Check size limit
    const byteLength = Buffer.byteLength(content, 'utf-8');
    if (byteLength > this.maxSizeBytes) {
      logger.warn(
        { byteLength, maxSize: this.maxSizeBytes, templateId: template.id },
        'Rendered content exceeds maximum size'
      );
    }

    return {
      content,
      templateId: template.id,
      renderedAt: new Date().toISOString(),
      unusedVariables,
      missingVariables,
    };
  }

  /**
   * Render template content string with a context object.
   *
   * This is the core rendering engine that processes:
   * 1. `{{#each items}}...{{/each}}` — List iteration
   * 2. `{{#if condition}}...{{/if}}` — Conditional blocks
   * 3. `{{#section}}...{{/section}}` — Truthy sections
   * 4. `{{variable}}` and `{{variable.property}}` — Variable substitution
   *
   * @param templateContent - Template string with placeholders
   * @param context - Variable context object
   * @returns Rendered string
   */
  renderContent(templateContent: string, context: RenderContext): string {
    let result = templateContent;

    // 1. Process {{#each items}}...{{/each}} blocks
    result = this.processEachBlocks(result, context);

    // 2. Process {{#if condition}}...{{/if}} blocks
    //    Run multiple passes to handle nested conditionals (e.g., {{#if}} inside {{#each}})
    let prev = '';
    let maxPasses = 5;
    while (result !== prev && maxPasses-- > 0) {
      prev = result;
      result = this.processConditionalBlocks(result, context);
    }

    // 3. Process {{#section}}...{{/section}} truthy blocks
    result = this.processSectionBlocks(result, context);

    // 4. Process {{variable}} substitutions
    result = this.processVariables(result, context);

    return result.trim();
  }

  /**
   * Convert a ResearchReport to a flat render context.
   *
   * Flattens nested structures so template variables can use dot notation:
   * `{{metadata.startTime}}` → accesses `context['metadata.startTime']`
   *
   * @param report - Research report data
   * @returns Flat context object with dot-notation keys
   */
  reportToContext(report: ResearchReport): RenderContext {
    const context: RenderContext = {
      title: report.title,
      topic: report.topic,
      summary: report.summary,
      objectives: report.objectives,
      findings: report.findings,
      conclusions: report.conclusions,
      recommendations: report.recommendations,
      resources: report.resources,
      pendingQuestions: report.pendingQuestions,
      outline: report.outline,
      'metadata.startTime': report.metadata.startTime,
      'metadata.endTime': report.metadata.endTime,
      'metadata.version': report.metadata.version,
      'metadata.author': report.metadata.author,
      'metadata.templateName': report.metadata.templateName,
    };

    return context;
  }

  /**
   * Process {{#each items}}...{{/each}} blocks.
   *
   * For object items, also processes {{#if property}} blocks within the body
   * using the item's properties as context.
   */
  private processEachBlocks(content: string, context: RenderContext): string {
    return content.replace(EACH_PATTERN, (_match, variableName: string, body: string) => {
      const items = this.resolveValue(variableName.trim(), context);

      if (!Array.isArray(items)) {
        return '';
      }

      return items
        .map((item, index) => {
          let section = body;

          // Replace {{index}} FIRST (before object property processing)
          section = section.replace(INDEX_PATTERN, String(index + 1));

          if (typeof item === 'string') {
            section = section.replace(THIS_PATTERN, item);
          } else if (typeof item === 'object' && item !== null) {
            // Replace {{this}} with JSON representation
            section = section.replace(THIS_PATTERN, JSON.stringify(item, null, 2));

            // Process {{#if property}} blocks using the item's properties as context
            // This handles conditionals like {{#if source}} inside {{#each findings}}
            const itemContext = item as Record<string, unknown>;
            section = this.processConditionalBlocksWithContext(section, itemContext);

            // Also allow direct property access: {{title}}, {{description}}, etc.
            section = this.processObjectProperties(section, itemContext);
          }

          return section;
        })
        .join('');
    });
  }

  /**
   * Process {{#if condition}}...{{/if}} blocks with a specific context.
   * Used for evaluating conditionals inside {{#each}} blocks against item properties.
   */
  private processConditionalBlocksWithContext(content: string, itemContext: Record<string, unknown>): string {
    return content.replace(CONDITIONAL_PATTERN, (_match, condition: string, body: string) => {
      const value = itemContext[condition.trim()];
      return this.isTruthy(value) ? body : '';
    });
  }

  /**
   * Process {{#if condition}}...{{/if}} blocks.
   */
  private processConditionalBlocks(content: string, context: RenderContext): string {
    return content.replace(CONDITIONAL_PATTERN, (_match, condition: string, body: string) => {
      const value = this.resolveValue(condition.trim(), context);
      return this.isTruthy(value) ? body : '';
    });
  }

  /**
   * Process {{#section}}...{{/section}} truthy blocks.
   */
  private processSectionBlocks(content: string, context: RenderContext): string {
    return content.replace(SECTION_PATTERN, (_match, sectionName: string, body: string) => {
      const value = this.resolveValue(sectionName.trim(), context);
      return this.isTruthy(value) ? body : '';
    });
  }

  /**
   * Process {{variable}} substitutions.
   */
  private processVariables(content: string, context: RenderContext): string {
    return content.replace(VARIABLE_PATTERN, (_match, variableName: string) => {
      const value = this.resolveValue(variableName.trim(), context);
      if (value === undefined || value === null) {
        return '';
      }
      if (typeof value === 'number') {
        return String(value);
      }
      if (typeof value === 'boolean') {
        return String(value);
      }
      if (typeof value === 'string') {
        return value;
      }
      // For objects/arrays, convert to string representation
      return String(value);
    });
  }

  /**
   * Process property access within an object context.
   * Replaces {{propertyName}} with the corresponding value from the object.
   */
  private processObjectProperties(content: string, obj: Record<string, unknown>): string {
    // Use a pattern that excludes 'this' and 'index' (already processed)
    const objectVarPattern = /\{\{(this|index|[^#/][^}]*?)\}\}/g;
    return content.replace(objectVarPattern, (_match, propertyName: string) => {
      if (propertyName === 'this' || propertyName === 'index') {
        return _match; // Leave as-is, already processed
      }
      const value = obj[propertyName.trim()];
      if (value === undefined || value === null) {
        return '';
      }
      if (Array.isArray(value)) {
        // Format arrays: wrap string items in backticks and join with space
        return value.map((v) => (typeof v === 'string' ? `\`${v}\`` : String(v))).join(' ');
      }
      return String(value);
    });
  }

  /**
   * Resolve a variable value from context.
   * Supports dot notation: "metadata.startTime" → context["metadata.startTime"]
   */
  private resolveValue(name: string, context: RenderContext): unknown {
    // Direct lookup (including dot-notation keys)
    if (name in context) {
      return context[name];
    }

    // Nested property access (e.g., "metadata.startTime" → context.metadata.startTime)
    const parts = name.split('.');
    if (parts.length > 1) {
      let current: unknown = context[parts[0]];
      for (let i = 1; i < parts.length; i++) {
        if (current === null || current === undefined || typeof current !== 'object') {
          return undefined;
        }
        current = (current as Record<string, unknown>)[parts[i]];
      }
      return current;
    }

    return undefined;
  }

  /**
   * Check if a value is truthy for conditional rendering.
   */
  private isTruthy(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.length > 0;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  /**
   * Find required variables that are missing from the context.
   */
  private findMissingVariables(template: ReportTemplate, context: RenderContext): string[] {
    return template.variables
      .filter((v) => v.required && !this.isTruthy(this.resolveValue(v.name, context)))
      .map((v) => v.name);
  }

  /**
   * Find context keys that are not used in the template.
   */
  private findUnusedVariables(template: ReportTemplate, context: RenderContext): string[] {
    const usedNames = new Set(template.variables.map((v) => v.name));
    return Object.keys(context).filter((key) => !usedNames.has(key));
  }

  /**
   * Parse a template file with YAML frontmatter.
   *
   * File format:
   * ```
   * ---
   * id: template-id
   * name: Template Name
   * description: Template description
   * tags: [tag1, tag2]
   * ---
   * Template content with {{variable}} placeholders...
   * ```
   *
   * @param content - Raw file content
   * @returns Parsed template, or undefined if parsing fails
   */
  private parseTemplateFile(content: string): ReportTemplate | undefined {
    // Check for YAML frontmatter
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      logger.warn('Template file missing YAML frontmatter, skipping');
      return undefined;
    }

    const [, frontmatter, body] = frontmatterMatch;

    // Simple YAML parsing (avoid js-yaml dependency for just this)
    const metadata = this.parseSimpleYaml(frontmatter);
    if (!metadata.id) {
      logger.warn('Template file missing "id" in frontmatter, skipping');
      return undefined;
    }

    // Extract variable names from the template content
    const variables = this.extractVariables(body);

    return {
      id: String(metadata.id),
      name: String(metadata.name ?? metadata.id),
      description: String(metadata.description ?? ''),
      format: 'markdown',
      content: body.trim(),
      variables,
      tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
    };
  }

  /**
   * Minimal YAML parser for template frontmatter.
   * Supports: strings, numbers, booleans, and arrays.
   */
  private parseSimpleYaml(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const line of yaml.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      if (value.startsWith('[') && value.endsWith(']')) {
        // Parse array: [item1, item2]
        const items = value
          .slice(1, -1)
          .split(',')
          .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
        result[key] = items;
      } else if (value === 'true') {
        result[key] = true;
      } else if (value === 'false') {
        result[key] = false;
      } else if (value === 'null' || value === '') {
        result[key] = null;
      } else if (/^-?\d+$/.test(value)) {
        result[key] = parseInt(value, 10);
      } else {
        // Remove surrounding quotes if present
        result[key] = value.replace(/^['"]|['"]$/g, '');
      }
    }

    return result;
  }

  /**
   * Extract variable definitions from template content.
   * Scans for {{variable}} patterns and creates variable definitions.
   */
  private extractVariables(content: string): Array<{
    name: string;
    description: string;
    type: 'string' | 'string[]' | 'number' | 'boolean' | 'object';
    required: boolean;
  }> {
    const variables: Array<{
      name: string;
      description: string;
      type: 'string' | 'string[]' | 'number' | 'boolean' | 'object';
      required: boolean;
    }> = [];
    const seenNames = new Set<string>();

    // Find all variable references
    const matches = content.matchAll(VARIABLE_PATTERN);
    for (const match of matches) {
      const name = match[1].trim();
      if (!name || name === 'this' || name === 'index') continue;

      if (!seenNames.has(name)) {
        seenNames.add(name);
        variables.push({
          name,
          description: `Auto-detected variable: ${name}`,
          type: 'string',
          required: false,
        });
      }
    }

    // Find #each references to mark array types
    const eachMatches = content.matchAll(EACH_PATTERN);
    for (const match of eachMatches) {
      const name = match[1].trim();
      const existing = variables.find((v) => v.name === name);
      if (existing) {
        existing.type = 'object'; // Arrays of objects
      }
    }

    return variables;
  }
}
