/**
 * Context builder for project instructions and knowledge base.
 *
 * Issue #1916: Builds formatted prompt sections that inject project-level
 * instructions (CLAUDE.md) and knowledge base content into agent messages.
 *
 * @module project/context-builder
 */

import path from 'path';
import type { ProjectContext, KnowledgeFileEntry } from '../config/types.js';

/**
 * Maximum recommended character count for knowledge base content.
 * Beyond this, the knowledge base may consume too much of the context window.
 */
export const DEFAULT_MAX_KNOWLEDGE_CHARS = 100_000;

/**
 * Supported file extensions for knowledge base files.
 * These are text-based formats that can be safely read and injected into prompts.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.freeze([
  'md',    // Markdown
  'txt',   // Plain text
  'csv',   // Comma-separated values
  'json',  // JSON
  'yaml',  // YAML
  'yml',   // YAML alternative
  'xml',   // XML
  'html',  // HTML (text content)
  'ts',    // TypeScript
  'js',    // JavaScript
  'tsx',   // TypeScript JSX
  'jsx',   // JavaScript JSX
  'py',    // Python
  'sh',    // Shell scripts
  'bash',  // Bash scripts
  'zsh',   // Zsh scripts
  'sql',   // SQL
  'toml',  // TOML
  'ini',   // INI
  'cfg',   // Config
  'conf',  // Config
  'env',   // Environment
  'log',   // Log files
  'rst',   // reStructuredText
  'org',   // Org-mode
  'adoc',  // AsciiDoc
  'graphql', // GraphQL
  'gql',   // GraphQL shorthand
  'proto', // Protocol Buffers
  'tf',    // Terraform
  'hcl',   // HCL
  'css',   // CSS
  'scss',  // SCSS
  'less',  // LESS
  'vue',   // Vue
  'svelte', // Svelte
  'rs',    // Rust
  'go',    // Go
  'java',  // Java
  'kt',    // Kotlin
  'swift', // Swift
  'c',     // C
  'cpp',   // C++
  'h',     // C header
  'hpp',   // C++ header
  'rb',    // Ruby
  'php',   // PHP
  'pl',    // Perl
  'r',     // R
  'lua',   // Lua
  'dart',  // Dart
  'ex',    // Elixir
  'exs',   // Elixir script
  'hs',    // Haskell
  'scala', // Scala
  'clj',   // Clojure
  'kt',    // Kotlin
]);

/**
 * Maximum characters per knowledge file to include in the prompt.
 * Files exceeding this limit are truncated with a note.
 */
const MAX_FILE_CHARS = 10_000;

/**
 * Build a formatted prompt section for project context.
 *
 * This function creates a well-structured prompt section that includes:
 * - Project name (if not "default")
 * - Project instructions (from CLAUDE.md)
 * - Knowledge base file contents
 *
 * The section is designed to be injected into the agent's user message
 * via the MessageBuilder pipeline.
 *
 * @param context - Loaded project context
 * @returns Formatted prompt section, or empty string if no project content
 *
 * @example
 * ```typescript
 * const pm = new ProjectManager(config, workspaceDir);
 * const ctx = pm.loadProject('book-reader');
 * const section = buildProjectContextSection(ctx);
 * if (section) {
 *   // Inject into agent prompt
 * }
 * ```
 */
export function buildProjectContextSection(context: ProjectContext): string {
  if (!context) {
    return '';
  }

  const sections: string[] = [];

  // Project label (only for non-default projects)
  if (context.name && context.name !== 'default') {
    sections.push(`**Active Project:** ${context.name}`);
  }

  // Project instructions
  if (context.instructions) {
    sections.push(buildInstructionsSection(context.instructions));
  }

  // Knowledge base
  if (context.knowledgeFiles.length > 0) {
    sections.push(buildKnowledgeSection(context.knowledgeFiles));
  }

  if (sections.length === 0) {
    return '';
  }

  return `\n---\n\n## Project Knowledge Base\n\n${sections.join('\n\n')}\n\n---`;
}

/**
 * Build the project instructions section from CLAUDE.md content.
 */
function buildInstructionsSection(instructions: string): string {
  // Truncate if too long
  const maxInstructionsChars = 5_000;
  let content = instructions;
  let truncated = false;

  if (content.length > maxInstructionsChars) {
    content = content.slice(0, maxInstructionsChars) + '\n\n... (truncated)';
    truncated = true;
  }

  return `### Project Instructions (CLAUDE.md)\n\n${content}${truncated ? '\n\n> ⚠️ Instructions truncated — consider condensing your CLAUDE.md.' : ''}`;
}

/**
 * Build the knowledge base section from loaded files.
 */
function buildKnowledgeSection(files: KnowledgeFileEntry[]): string {
  const parts: string[] = [];

  for (const file of files) {
    const relPath = file.path; // Use full path for clarity
    const extLabel = file.extension.toUpperCase() || 'TEXT';
    let content = file.content;

    // Truncate large files
    let truncated = false;
    if (content.length > MAX_FILE_CHARS) {
      content = content.slice(0, MAX_FILE_CHARS) + '\n\n... (truncated)';
      truncated = true;
    }

    parts.push(
      `#### 📄 ${file.name}\n` +
      `- Path: \`${relPath}\`\n` +
      `- Type: ${extLabel}${truncated ? ' (truncated)' : ''}\n\n` +
      '```\n' +
      content +
      '\n```'
    );
  }

  return `### Knowledge Base Files (${files.length} files)\n\n${parts.join('\n\n')}`;
}
