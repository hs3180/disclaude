/**
 * Research SOUL content generator.
 *
 * Issue #1709: Research Mode - SOUL + cwd + Skill set switching.
 *
 * Generates the Research SOUL content that defines behavioral
 * guidelines for the agent when operating in research mode.
 * This is prompt-based (not enforced at SDK level) per the
 * codebase's established pattern (see Issue #1371).
 *
 * @module mode/research-soul
 */

import type { ResearchModeConfig } from './types.js';

/**
 * Generate Research SOUL content for a specific topic.
 *
 * The SOUL provides behavioral guidelines for the agent in research mode:
 * - Directory access restrictions (prompt-level)
 * - Research methodology guidelines
 * - Output expectations
 *
 * @param topic - Research topic name
 * @returns Research SOUL content as markdown string
 */
export function generateResearchSoulContent(topic: string): string {
  return `
---

## Research Mode Active: ${topic}

You are currently operating in **Research Mode** for the topic: **${topic}**.

### Directory Access Rules

- **Allowed**: Only access files within the current research working directory and its subdirectories
- **Prohibited**: Do not access other project files in the workspace
- **Prohibited**: Do not access system directories or paths outside the research directory
- **Rationale**: Research mode provides an isolated environment to prevent cross-contamination between research topics and daily work

### Research Methodology

1. **Define Scope**: Clearly state what you are researching and what questions you need to answer
2. **Systematic Gathering**: Collect information from authoritative sources, document findings
3. **Organize Notes**: Structure findings in the research working directory using markdown files
4. **Cite Sources**: Always cite sources for any claims or data points
5. **Track Progress**: Update the research state file (RESEARCH.md) as you make progress

### Output Guidelines

- Focus on thoroughness and accuracy over speed
- Present findings in structured markdown format
- Include confidence levels for uncertain findings
- Clearly separate facts from analysis/opinion
- List open questions that need further investigation

### Available Research Skills

In research mode, focus on these capabilities:
- **Web Search**: Search for information across the web
- **Code Reading**: Read and analyze code (read-only)
- **Note Taking**: Create and maintain research notes in the working directory
- **File Analysis**: Analyze documents and data files in the research directory

---
`;
}

/**
 * Create a ResearchModeConfig for a given topic and workspace.
 *
 * @param topic - Research topic name (will be sanitized for use as directory name)
 * @param workspaceDir - Base workspace directory
 * @returns ResearchModeConfig with topic, cwd, soul content, and activation timestamp
 */
export function createResearchModeConfig(
  topic: string,
  workspaceDir: string
): ResearchModeConfig {
  const sanitizedTopic = sanitizeTopicName(topic);
  return {
    topic: sanitizedTopic,
    cwd: `${workspaceDir}/workspace/research/${sanitizedTopic}`,
    soulContent: generateResearchSoulContent(sanitizedTopic),
    activatedAt: new Date().toISOString(),
  };
}

/**
 * Sanitize a topic name for use as a directory name.
 *
 * Removes or replaces characters that are unsafe for directory names.
 *
 * @param topic - Raw topic name
 * @returns Sanitized topic name safe for directory use
 */
export function sanitizeTopicName(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-_]/g, '-') // Allow alphanumeric, CJK, hyphens, underscores
    .replace(/-+/g, '-')                          // Collapse multiple hyphens
    .replace(/^-|-$/g, '')                        // Remove leading/trailing hyphens
    .slice(0, 64)                                 // Limit length
    || 'untitled';                                // Fallback for empty result
}
