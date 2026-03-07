/**
 * Mind Map Generator Tool for NotebookLM features (Issue #950 M3).
 *
 * Generates mind maps from content in Mermaid and Markmap formats.
 *
 * @module mcp/tools/mindmap-generator
 */

// ============================================================================
// Type Definitions
// ============================================================================

export interface MindmapNode {
  /** Node text content */
  text: string;
  /** Child nodes */
  children?: MindmapNode[];
  /** Node icon (optional, for visual enhancement) */
  icon?: string;
}

export interface MindmapGeneratorOptions {
  /** The content to generate mind map from */
  content: string;
  /** Output format: 'mermaid' | 'markmap' | 'both' */
  format?: 'mermaid' | 'markmap' | 'both';
  /** Title for the mind map root */
  title?: string;
  /** Maximum depth of the mind map */
  maxDepth?: number;
  /** Maximum number of nodes per level */
  maxNodesPerLevel?: number;
}

export interface MindmapGeneratorResult {
  success: boolean;
  /** Mermaid format mind map */
  mermaid?: string;
  /** Markmap format mind map (Markdown) */
  markmap?: string;
  /** Parsed node structure */
  nodes?: MindmapNode;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Mermaid Mindmap Generator
// ============================================================================

/**
 * Convert a MindmapNode tree to Mermaid mindmap syntax.
 *
 * Mermaid mindmap syntax example:
 * ```mermaid
 * mindmap
 *   root((Project))
 *     Branch1
 *       Leaf1
 *       Leaf2
 *     Branch2
 *       Leaf3
 * ```
 */
function nodeToMermaid(node: MindmapNode, indent: number = 0): string {
  const spaces = '  '.repeat(indent);
  let result = '';

  // Escape special characters for Mermaid
  const escapeText = (text: string): string => {
    // Replace special characters that might break Mermaid syntax
    return text
      .replace(/[(){}[\]]/g, '')
      .replace(/\n/g, ' ')
      .trim();
  };

  const escapedText = escapeText(node.text);

  if (indent === 0) {
    // Root node uses circle syntax
    result += `${spaces}root((${escapedText}))\n`;
  } else {
    result += `${spaces}${escapedText}\n`;
  }

  // Add children
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      result += nodeToMermaid(child, indent + 1);
    }
  }

  return result;
}

/**
 * Generate a Mermaid mindmap from a node structure.
 */
function generateMermaidMindmap(root: MindmapNode): string {
  return `mindmap\n${nodeToMermaid(root, 0)}`;
}

// ============================================================================
// Markmap Generator
// ============================================================================

/**
 * Convert a MindmapNode tree to Markmap (Markdown) syntax.
 *
 * Markmap uses standard Markdown headings with indentation:
 * ```markdown
 * # Project
 * ## Branch1
 * ### Leaf1
 * ### Leaf2
 * ## Branch2
 * ### Leaf3
 * ```
 */
function nodeToMarkmap(node: MindmapNode, level: number = 1): string {
  const prefix = '#'.repeat(Math.min(level, 6));
  let result = `${prefix} ${node.text}\n`;

  // Add children
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      result += nodeToMarkmap(child, level + 1);
    }
  }

  return result;
}

/**
 * Generate a Markmap-compatible markdown from a node structure.
 */
function generateMarkmapMindmap(root: MindmapNode): string {
  return nodeToMarkmap(root, 1);
}

// ============================================================================
// Content Analysis
// ============================================================================

/**
 * Extract structure from content to create a mind map.
 * This function analyzes the content and extracts headings, lists, and key concepts.
 */
function extractStructureFromContent(
  content: string,
  maxDepth: number = 3,
  maxNodesPerLevel: number = 6
): MindmapNode {
  const lines = content.split('\n').filter(line => line.trim());

  // Try to extract structure from markdown headings
  const headingPattern = /^(#{1,6})\s+(.+)$/;
  const listPattern = /^[-*+]\s+(.+)$/;

  const root: MindmapNode = { text: 'Main Topic', children: [] };
  const stack: { node: MindmapNode; level: number }[] = [{ node: root, level: 0 }];

  let currentNodeCount = 0;

  for (const line of lines) {
    const headingMatch = line.match(headingPattern);
    const listMatch = line.match(listPattern);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();

      // Skip if we've exceeded max depth or max nodes
      if (level > maxDepth || currentNodeCount >= maxNodesPerLevel * maxDepth) {
        continue;
      }

      const newNode: MindmapNode = { text, children: [] };

      // Find the appropriate parent based on level
      while (stack.length > 1 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      const parent = stack[stack.length - 1].node;
      if (parent.children) {
        parent.children.push(newNode);
      } else {
        parent.children = [newNode];
      }

      stack.push({ node: newNode, level });
      currentNodeCount++;
    } else if (listMatch && stack.length > 1) {
      // Add list items as children of the current heading
      const text = listMatch[1].trim();
      const currentLevel = stack[stack.length - 1].level;

      // Skip if we've exceeded max depth
      if (currentLevel + 1 > maxDepth) {
        continue;
      }

      const newNode: MindmapNode = { text };

      const parent = stack[stack.length - 1].node;
      if (parent.children) {
        // Limit children per node
        if (parent.children.length < maxNodesPerLevel) {
          parent.children.push(newNode);
        }
      } else {
        parent.children = [newNode];
      }
      currentNodeCount++;
    }
  }

  // If no structure was found, create a simple structure from key sentences
  if (!root.children || root.children.length === 0) {
    const sentences = content
      .split(/[.!?。！？\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10 && s.length < 100)
      .slice(0, maxNodesPerLevel);

    root.children = sentences.map(sentence => ({ text: sentence }));
  }

  return root;
}

// ============================================================================
// Main Generator Function
// ============================================================================

/**
 * Generate a mind map from content.
 *
 * This function analyzes the content structure and generates a mind map
 * in the specified format(s).
 *
 * @example
 * ```typescript
 * const result = generate_mindmap({
 *   content: '# Project\n## Feature A\n## Feature B',
 *   format: 'mermaid',
 *   title: 'My Project'
 * });
 * ```
 */
export function generate_mindmap(options: MindmapGeneratorOptions): MindmapGeneratorResult {
  const {
    content,
    format = 'mermaid',
    title = 'Mind Map',
    maxDepth = 3,
    maxNodesPerLevel = 6,
  } = options;

  if (!content || content.trim().length === 0) {
    return {
      success: false,
      error: 'Content is required for mind map generation',
    };
  }

  try {
    // Extract structure from content
    const nodeStructure = extractStructureFromContent(content, maxDepth, maxNodesPerLevel);

    // Override root title if provided
    if (title && title !== 'Main Topic') {
      nodeStructure.text = title;
    }

    const result: MindmapGeneratorResult = {
      success: true,
      nodes: nodeStructure,
    };

    // Generate in requested format(s)
    if (format === 'mermaid' || format === 'both') {
      result.mermaid = generateMermaidMindmap(nodeStructure);
    }

    if (format === 'markmap' || format === 'both') {
      result.markmap = generateMarkmapMindmap(nodeStructure);
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: `Failed to generate mind map: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================================
// Prompt Template Generator
// ============================================================================

/**
 * Generate a prompt template for LLM-based mind map generation.
 * This provides guidance for the LLM to create a well-structured mind map.
 */
export function generate_mindmap_prompt(content: string, title?: string): string {
  const titleSection = title ? `**Title**: ${title}` : '';

  return `## Mind Map Generation Request

${titleSection}

### Content
\`\`\`
${content}
\`\`\`

---

**Instructions**: Generate a mind map based on the content above.

**Analysis Steps**:
1. Identify the main topic/central idea
2. Extract 3-7 primary branches (main concepts)
3. For each branch, identify 2-5 sub-topics
4. Keep node labels concise (1-5 words)

**Output Format** (Mermaid):
\`\`\`mermaid
mindmap
  root((Central Idea))
    Branch1
      Sub-topic 1
      Sub-topic 2
    Branch2
      Sub-topic 1
      Sub-topic 2
    Branch3
      Sub-topic 1
\`\`\`

**Guidelines**:
- Use clear, descriptive labels
- Maintain logical hierarchy
- Balance the tree (avoid too many or too few branches)
- Focus on key concepts, not details
`;
}
