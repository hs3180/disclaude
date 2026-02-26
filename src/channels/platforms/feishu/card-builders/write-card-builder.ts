/**
 * Feishu interactive card builder for Write tool content preview.
 * Provides content preview with truncation for large files.
 *
 * Reference: https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags
 */

/**
 * Configuration for content preview.
 */
export interface WritePreviewConfig {
  /** Maximum lines to show before truncating (default: 50) */
  maxLines?: number;
  /** Maximum characters per line (default: 200) */
  maxCharsPerLine?: number;
  /** Lines to show at the beginning and end when truncating (default: 10) */
  contextLines?: number;
}

/**
 * Default preview configuration.
 */
const DEFAULT_CONFIG: Required<WritePreviewConfig> = {
  maxLines: 50,
  maxCharsPerLine: 200,
  contextLines: 10,
};

/**
 * Write content record for preview display.
 */
export interface WriteContent {
  /** File path being written */
  filePath: string;
  /** Programming language for syntax highlighting */
  language?: string;
  /** Content being written to the file */
  content: string;
  /** Total number of lines in the content */
  totalLines: number;
  /** Whether the content is truncated */
  isTruncated: boolean;
  /** Preview lines (either full content or truncated version) */
  previewLines: string[];
}

/**
 * Build a content preview card for Write tool use.
 *
 * Features:
 * - File path header with language badge
 * - Full content display if under threshold
 * - Truncated preview with context if over threshold
 * - Line numbers for reference
 * - Syntax highlighting support
 *
 * @param writeContent - Write content object
 * @param title - Optional card title (default: "✍️ 文件写入")
 * @param template - Optional header template color (default: "green")
 * @param config - Optional preview configuration
 * @returns Interactive card JSON structure
 */
export function buildWriteContentCard(
  writeContent: WriteContent,
  title: string = '✍️ 文件写入',
  template: string = 'green',
  config: WritePreviewConfig = {}
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  // Merge config with defaults
  const previewConfig = { ...DEFAULT_CONFIG, ...config };

  // File header with language badge and line count
  const languageBadge = writeContent.language ? `\`${writeContent.language}\`` : '';
  const lineCountText = `${writeContent.totalLines} 行`;
  const truncatedBadge = writeContent.isTruncated ? ' *(已截断)*' : '';

  const headerText = `**📄 ${escapeHtml(writeContent.filePath)}** ${languageBadge} • ${lineCountText}${truncatedBadge}\n`;

  elements.push({
    tag: 'markdown',
    content: headerText,
  });

  // Generate content preview
  const contentPreview = generateContentPreview(writeContent, previewConfig);
  elements.push({
    tag: 'markdown',
    content: contentPreview,
  });

  // Add truncation notice if applicable
  if (writeContent.isTruncated) {
    const omittedLines = writeContent.totalLines - writeContent.previewLines.length;
    const notice = `\n\n📝 *已省略中间 ${omittedLines} 行，仅显示开头和结尾内容*`;
    elements.push({
      tag: 'markdown',
      content: notice,
    });
  }

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
 * Generate content preview with line numbers.
 *
 * @param writeContent - Write content object
 * @param config - Preview configuration
 * @returns Markdown-formatted content preview
 */
function generateContentPreview(writeContent: WriteContent, config: Required<WritePreviewConfig>): string {
  const lines: string[] = [];

  // Build code block with language
  const language = writeContent.language ?? 'text';

  lines.push(`\`\`\`${  language}`);

  // Add each line with line number
  let startLineNumber = 1;

  if (writeContent.isTruncated) {
    // Truncated mode: show start lines, ellipsis, end lines
    for (let i = 0; i < writeContent.previewLines.length; i++) {
      const line = writeContent.previewLines[i];

      // Check if we're in the ellipsis section
      if (line === TRUNCATION_MARKER) {
        lines.push('');
        lines.push('⋮');
        lines.push('');

        // Adjust line number for the end section
        const linesRemaining = writeContent.previewLines.length - i - 1;
        startLineNumber = writeContent.totalLines - linesRemaining + 1;
        continue;
      }

      const lineNumber = i < config.contextLines
        ? i + 1
        : startLineNumber++;

      const truncatedLine = truncateLine(line, config.maxCharsPerLine);
      lines.push(`${String(lineNumber).padStart(4, ' ')} | ${truncatedLine}`);
    }
  } else {
    // Full content mode
    for (let i = 0; i < writeContent.previewLines.length; i++) {
      const line = writeContent.previewLines[i];
      const truncatedLine = truncateLine(line, config.maxCharsPerLine);
      lines.push(`${String(i + 1).padStart(4, ' ')} | ${truncatedLine}`);
    }
  }

  lines.push('```');

  return lines.join('\n');
}

/**
 * Marker for truncation point in preview.
 */
const TRUNCATION_MARKER = '__TRUNCATION__';

/**
 * Parse Write tool input into WriteContent format.
 * Extracts file_path and content from SDK tool input.
 *
 * @param input - Tool input from SDK Write tool
 * @param config - Optional preview configuration
 * @returns WriteContent object or null if parsing fails
 */
export function parseWriteToolInput(
  input: Record<string, unknown> | undefined,
  config: WritePreviewConfig = {}
): WriteContent | null {
  if (!input) { return null; }

  // SDK uses snake_case for Write tool parameters
  const filePath = (input.file_path as string | undefined) || (input.filePath as string | undefined);
  const content = input.content as string | undefined;

  if (!filePath) { return null; }
  if (content === undefined) { return null; }

  // Merge config with defaults
  const previewConfig = { ...DEFAULT_CONFIG, ...config };

  // Detect language from file extension
  const language = detectLanguage(filePath);

  // Split content into lines
  const allLines = content.split('\n');
  const totalLines = allLines.length;

  // Determine if truncation is needed
  const isTruncated = totalLines > previewConfig.maxLines;

  // Generate preview lines
  let previewLines: string[];

  if (isTruncated) {
    // Show first N lines and last N lines with truncation marker
    const {contextLines} = previewConfig;
    const startLines = allLines.slice(0, contextLines);
    const endLines = allLines.slice(-contextLines);

    previewLines = [
      ...startLines,
      TRUNCATION_MARKER,
      ...endLines,
    ];
  } else {
    // Show all lines
    previewLines = allLines;
  }

  return {
    filePath,
    language,
    content,
    totalLines,
    isTruncated,
    previewLines,
  };
}

/**
 * Truncate a line to maximum characters for display.
 *
 * @param line - Line to truncate
 * @param maxLength - Maximum characters
 * @returns Truncated line with ellipsis if needed
 */
function truncateLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) {
    return line;
  }

  // Truncate and add ellipsis
  return `${line.substring(0, maxLength - 3)  }...`;
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
