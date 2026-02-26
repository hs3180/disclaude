/**
 * Feishu interactive card builder for code diffs.
 * Provides Unified Diff style formatting for Edit Tool Use messages.
 *
 * Reference: https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags
 */

/**
 * Code change record for diff display.
 */
export interface CodeChange {
  /** File path being edited */
  filePath: string;
  /** Programming language for syntax highlighting */
  language?: string;
  /** Lines being removed (old version) */
  removed?: string[];
  /** Lines being added (new version) */
  added?: string[];
  /** Starting line number in old version (optional) */
  oldLineStart?: number;
  /** Starting line number in new version (optional) */
  newLineStart?: number;
}

/**
 * Build a Unified Diff style interactive card.
 *
 * Features:
 * - File path header with emoji
 * - Single code block with git diff unified format
 * - Context lines before and after changes
 * - Removed lines in red with `-` prefix
 * - Added lines in green with `+` prefix
 * - Git-style diff formatting in code blocks
 *
 * @param changes - Array of code changes to display
 * @param title - Optional card title (default: "📝 代码编辑")
 * @param template - Optional header template color (default: "orange")
 * @returns Interactive card JSON structure
 */
export function buildUnifiedDiffCard(
  changes: CodeChange[],
  title: string = '📝 代码编辑',
  template: string = 'orange'
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  for (const change of changes) {
    const contentParts: string[] = [];

    // File header with language badge
    const languageBadge = change.language ? `\`${change.language}\`` : '';
    contentParts.push(`**📄 ${escapeHtml(change.filePath)}** ${languageBadge}\n`);

    // Generate git diff style unified format
    const diffContent = generateUnifiedDiff(change);
    contentParts.push(diffContent);

    elements.push({
      tag: 'markdown',
      content: contentParts.join(''),
    });

    // Add separator between files
    elements.push({ tag: 'hr' });
  }

  // Remove last separator
  elements.pop();

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
      template,
    },
    elements,
  };
}

/**
 * Generate git diff unified format with context.
 *
 * @param change - Code change object
 * @returns Markdown-formatted diff content
 */
function generateUnifiedDiff(change: CodeChange): string {
  const diffLines: string[] = [];

  const removed = change.removed ?? [];
  const added = change.added ?? [];

  // Build unified diff by comparing lines
  const unifiedLines = buildUnifiedDiffLines(removed, added);

  // Build diff header
  const oldLineStart = change.oldLineStart ?? 1;
  const newLineStart = change.newLineStart ?? 1;
  const totalRemoved = removed.length;
  const totalAdded = added.length;

  diffLines.push('```diff');
  diffLines.push(`@@ -${oldLineStart},${totalRemoved} +${newLineStart},${totalAdded} @@`);

  // Add all diff lines
  for (const line of unifiedLines) {
    diffLines.push(line);
  }

  diffLines.push('```');

  return diffLines.join('\n');
}

/**
 * Build unified diff lines comparing removed and added content.
 * Uses a simple line-by-line comparison with context.
 *
 * @param removed - Lines being removed
 * @param added - Lines being added
 * @returns Array of formatted diff lines
 */
function buildUnifiedDiffLines(removed: string[], added: string[]): string[] {
  const lines: string[] = [];

  // Simple approach: if we have both removed and added, show them in unified format
  // If only one exists, show all lines with appropriate prefix

  if (removed.length === 0 && added.length > 0) {
    // Only additions
    for (const line of added) {
      lines.push(`+${escapeForCodeBlock(line)}`);
    }
  } else if (added.length === 0 && removed.length > 0) {
    // Only deletions
    for (const line of removed) {
      lines.push(`-${escapeForCodeBlock(line)}`);
    }
  } else if (removed.length > 0 && added.length > 0) {
    // Both exist - show in unified format
    // Strategy: Show all removed lines first, then all added lines
    // This is simplified but effective for showing the change

    for (const line of removed) {
      lines.push(`-${escapeForCodeBlock(line)}`);
    }

    for (const line of added) {
      lines.push(`+${escapeForCodeBlock(line)}`);
    }
  }

  return lines;
}

/**
 * Parse Edit tool input into CodeChange format.
 * Extracts file_path, old_string, and new_string from SDK tool input.
 *
 * @param input - Tool input from SDK Edit tool
 * @returns CodeChange object or null if parsing fails
 */
export function parseEditToolInput(input: Record<string, unknown> | undefined): CodeChange | null {
  if (!input) {return null;}

  // SDK uses snake_case for Edit tool parameters
  const filePath = (input.file_path as string | undefined) || (input.filePath as string | undefined);
  const oldString = (input.old_string as string | undefined) || (input.oldString as string | undefined);
  const newString = (input.new_string as string | undefined) || (input.newString as string | undefined);

  if (!filePath) {return null;}

  // Detect language from file extension
  const language = detectLanguage(filePath);

  // Split strings into lines for diff display
  const removed = oldString?.split('\n') ?? [];
  const added = newString?.split('\n') ?? [];

  return {
    filePath,
    language,
    removed: removed.length > 0 ? removed : undefined,
    added: added.length > 0 ? added : undefined,
  };
}

/**
 * Detect programming language from file path.
 *
 * @param filePath - File path with extension
 * @returns Language identifier for syntax highlighting
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    // Web/Scripting
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    vue: 'vue',
    svelte: 'svelte',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    json: 'json',
    xml: 'xml',

    // Backend
    py: 'python',
    rb: 'ruby',
    php: 'php',
    java: 'java',
    kt: 'kotlin',
    scala: 'scala',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    fs: 'fsharp',
    swift: 'swift',
    dart: 'dart',
    lua: 'lua',
    r: 'r',

    // Config/Markup
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    conf: 'ini',
    md: 'markdown',
    markdown: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    sql: 'sql',

    // Stylesheets
    svg: 'xml',
  };

  return languageMap[ext ?? ''] ?? 'text';
}

/**
 * Escape HTML special characters for safe rendering in Feishu markdown.
 *
 * @param text - Text to escape
 * @returns Escaped text
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escape special characters for code blocks.
 * Preserves backticks and other markdown-sensitive characters.
 *
 * @param text - Text to escape for code block
 * @returns Escaped text safe for code blocks
 */
function escapeForCodeBlock(text: string): string {
  // In code blocks, we need to escape backticks to prevent premature closing
  // but keep other characters as-is for proper display
  return text.replace(/`/g, '\\`');
}
