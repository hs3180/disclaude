/**
 * Mindmap generator tool implementation.
 *
 * Generates Mermaid mindmap format from structured content.
 * Part of NotebookLM features (Issue #950, M3).
 *
 * @module mcp/tools/mindmap-generator
 */

import { createLogger } from '../../utils/logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const logger = createLogger('MindmapGenerator');

export interface MindmapNode {
  text: string;
  children?: MindmapNode[];
}

export interface GenerateMindmapParams {
  /** Root topic/title of the mindmap */
  topic: string;
  /** Array of main branches (can have nested children) */
  branches: MindmapNode[];
  /** Output format: 'mermaid' (default) or 'markmap' */
  format?: 'mermaid' | 'markmap';
  /** Optional: save to file path (relative to workspace) */
  saveToFile?: string;
}

export interface GenerateMindmapResult {
  success: boolean;
  mindmap: string;
  message: string;
  filePath?: string;
  error?: string;
}

/**
 * Escape special characters for Mermaid mindmap syntax.
 */
function escapeMermaidText(text: string): string {
  // Mermaid mindmap has specific escape rules
  // Special characters that need escaping: ()[]{}<>""''
  // Also handle multi-line text by replacing newlines with spaces
  return text
    .replace(/\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}

/**
 * Convert a MindmapNode to Mermaid mindmap lines.
 */
function nodeToMermaidLines(node: MindmapNode, indent: number = 2): string[] {
  const lines: string[] = [];
  const indentStr = ' '.repeat(indent);

  if (node.children && node.children.length > 0) {
    lines.push(`${indentStr}${escapeMermaidText(node.text)}`);
    for (const child of node.children) {
      lines.push(...nodeToMermaidLines(child, indent + 2));
    }
  } else {
    lines.push(`${indentStr}${escapeMermaidText(node.text)}`);
  }

  return lines;
}

/**
 * Generate Mermaid mindmap format.
 */
function generateMermaidMindmap(topic: string, branches: MindmapNode[]): string {
  const lines: string[] = [];

  lines.push('```mermaid');
  lines.push('mindmap');
  lines.push(`  root((${escapeMermaidText(topic)}))`);

  for (const branch of branches) {
    lines.push(...nodeToMermaidLines(branch, 4));
  }

  lines.push('```');

  return lines.join('\n');
}

/**
 * Convert a MindmapNode to Markmap (Markdown) lines.
 */
function nodeToMarkmapLines(node: MindmapNode, level: number = 1): string[] {
  const lines: string[] = [];
  const prefix = '  '.repeat(level) + '-';

  if (node.children && node.children.length > 0) {
    lines.push(`${prefix} ${node.text}`);
    for (const child of node.children) {
      lines.push(...nodeToMarkmapLines(child, level + 1));
    }
  } else {
    lines.push(`${prefix} ${node.text}`);
  }

  return lines;
}

/**
 * Generate Markmap (Markdown with checkbox) format.
 */
function generateMarkmapMindmap(topic: string, branches: MindmapNode[]): string {
  const lines: string[] = [];

  lines.push(`# ${topic}`);
  lines.push('');
  lines.push('<!-- Use markmap-cli or https://markmap.js.org/repl to visualize -->');
  lines.push('');

  for (const branch of branches) {
    lines.push(...nodeToMarkmapLines(branch, 0));
  }

  return lines.join('\n');
}

/**
 * Generate a mindmap from structured content.
 *
 * @param params - Mindmap generation parameters
 * @returns Result with generated mindmap content
 *
 * @example
 * ```typescript
 * const result = await generate_mindmap({
 *   topic: 'Project Planning',
 *   branches: [
 *     { text: 'Phase 1', children: [
 *       { text: 'Research' },
 *       { text: 'Design' }
 *     ]},
 *     { text: 'Phase 2', children: [
 *       { text: 'Development' },
 *       { text: 'Testing' }
 *     ]}
 *   ],
 *   format: 'mermaid'
 * });
 * ```
 */
export async function generate_mindmap(params: GenerateMindmapParams): Promise<GenerateMindmapResult> {
  const { topic, branches, format = 'mermaid', saveToFile } = params;

  logger.info({ topic, branchCount: branches.length, format }, 'generate_mindmap called');

  try {
    // Validate input
    if (!topic || topic.trim() === '') {
      return {
        success: false,
        mindmap: '',
        message: '❌ Topic is required',
        error: 'Topic cannot be empty',
      };
    }

    if (!branches || branches.length === 0) {
      return {
        success: false,
        mindmap: '',
        message: '❌ At least one branch is required',
        error: 'Branches array cannot be empty',
      };
    }

    // Generate mindmap content
    let mindmapContent: string;

    if (format === 'markmap') {
      mindmapContent = generateMarkmapMindmap(topic, branches);
    } else {
      mindmapContent = generateMermaidMindmap(topic, branches);
    }

    // Save to file if requested
    let filePath: string | undefined;
    if (saveToFile) {
      const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
      filePath = path.isAbsolute(saveToFile)
        ? saveToFile
        : path.join(workspaceDir, saveToFile);

      // Ensure directory exists
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      // Write file
      await fs.writeFile(filePath, mindmapContent, 'utf-8');
      logger.info({ filePath }, 'Mindmap saved to file');
    }

    const message = saveToFile
      ? `✅ Mindmap generated (${format} format) and saved to ${saveToFile}`
      : `✅ Mindmap generated (${format} format)`;

    return {
      success: true,
      mindmap: mindmapContent,
      message,
      filePath,
    };

  } catch (error) {
    logger.error({ err: error }, 'generate_mindmap failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      mindmap: '',
      message: `❌ Failed to generate mindmap: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

/**
 * Generate a mindmap from plain text outline.
 *
 * Converts a simple text outline into Mermaid mindmap format.
 * Outline format:
 * - Lines starting with "# " are main topics
 * - Lines starting with "## " are subtopics
 * - Lines starting with "- " are leaf nodes
 * - Lines starting with "  - " are nested under previous item
 *
 * @param params - Text outline parameters
 * @returns Result with generated mindmap content
 */
export async function generate_mindmap_from_outline(params: {
  /** Title of the mindmap */
  title: string;
  /** Text outline content */
  outline: string;
  /** Output format */
  format?: 'mermaid' | 'markmap';
  /** Optional: save to file */
  saveToFile?: string;
}): Promise<GenerateMindmapResult> {
  const { title, outline, format = 'mermaid', saveToFile } = params;

  logger.info({ title, format }, 'generate_mindmap_from_outline called');

  try {
    // Parse outline into branches
    const branches: MindmapNode[] = [];
    const lines = outline.split('\n');

    let currentBranch: MindmapNode | null = null;
    let currentSubtopic: MindmapNode | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('# ')) {
        // Main topic - save previous branch and start new one
        if (currentBranch) {
          branches.push(currentBranch);
        }
        currentBranch = { text: trimmed.slice(2), children: [] };
        currentSubtopic = null;
      } else if (trimmed.startsWith('## ') && currentBranch) {
        // Subtopic
        currentSubtopic = { text: trimmed.slice(3), children: [] };
        if (currentBranch.children) {
          currentBranch.children.push(currentSubtopic);
        }
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        const leafText = trimmed.slice(2);
        if (currentSubtopic && currentSubtopic.children) {
          // Add to current subtopic
          currentSubtopic.children.push({ text: leafText });
        } else if (currentBranch && currentBranch.children) {
          // Add directly to branch
          currentBranch.children.push({ text: leafText });
        }
      }
    }

    // Don't forget the last branch
    if (currentBranch) {
      branches.push(currentBranch);
    }

    if (branches.length === 0) {
      return {
        success: false,
        mindmap: '',
        message: '❌ No valid outline structure found',
        error: 'Could not parse any topics from outline',
      };
    }

    // Generate mindmap using the parsed structure
    return generate_mindmap({
      topic: title,
      branches,
      format,
      saveToFile,
    });

  } catch (error) {
    logger.error({ err: error }, 'generate_mindmap_from_outline failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      mindmap: '',
      message: `❌ Failed to parse outline: ${errorMessage}`,
      error: errorMessage,
    };
  }
}
