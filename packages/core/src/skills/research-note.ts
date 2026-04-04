/**
 * Research Note - RESEARCH.md lifecycle management utilities.
 *
 * Issue #1710: RESEARCH.md 研究状态文件
 *
 * This module provides:
 * - RESEARCH.md template generation
 * - Research status parsing from RESEARCH.md content
 * - Initial content generation with topic, goals, and questions
 * - Conclusion archival content generation
 *
 * ## Integration Points
 *
 * - **Research Mode** (Issue #1709): When available, `setupResearchWorkspace()`
 *   in mode.ts can call `generateInitialResearchMd()` to create the initial file.
 * - **research-note Skill**: The SKILL.md references these utilities via agent instructions.
 *
 * @module skills/research-note
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Research status as tracked in RESEARCH.md header.
 */
export type ResearchStatus = 'in-progress' | 'paused' | 'completed';

/**
 * Parsed research status information from RESEARCH.md content.
 */
export interface ParsedResearchStatus {
  /** Current research status */
  status: ResearchStatus;
  /** Research topic (from H1 heading) */
  topic: string;
  /** Creation date if found in metadata */
  createdAt: string | null;
}

/**
 * Options for generating initial RESEARCH.md content.
 */
export interface ResearchNoteOptions {
  /** Research topic/title */
  topic: string;
  /** Brief description of research goals and background */
  description: string;
  /** Research objectives to track */
  goals: string[];
  /** Initial questions to investigate */
  questions?: string[];
}

/**
 * Options for generating conclusion section.
 */
export interface ResearchConclusionOptions {
  /** Core findings from the research */
  coreFindings: string[];
  /** Recommendations based on findings */
  recommendations?: string[];
  /** Unresolved issues from the research */
  unresolvedIssues?: string[];
  /** Suggested follow-up research directions */
  followUpDirections?: string[];
}

// ============================================================================
// Constants
// ============================================================================

/** Status emoji markers used in RESEARCH.md */
export const RESEARCH_STATUS_MARKERS = {
  'in-progress': '🟡',
  'paused': '🟠',
  'completed': '🟢',
} as const;

/** Status display labels */
export const RESEARCH_STATUS_LABELS = {
  'in-progress': '进行中',
  'paused': '已暂停',
  'completed': '已完成',
} as const;

/** Regex pattern to extract status from RESEARCH.md metadata line */
const STATUS_PATTERN = /^>\s*状态:\s*(🟡|🟠|🟢)/m;

/** Regex pattern to extract topic from H1 heading */
const TOPIC_PATTERN = /^#\s+(.+)$/m;

/** Regex pattern to extract creation date */
const CREATED_AT_PATTERN = /^>\s*创建时间:\s*(\d{4}-\d{2}-\d{2})/m;

/** Reverse lookup from emoji to status */
const EMOJI_TO_STATUS: Record<string, ResearchStatus> = {
  '🟡': 'in-progress',
  '🟠': 'paused',
  '🟢': 'completed',
};

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Generate initial RESEARCH.md content.
 *
 * Creates a complete RESEARCH.md file with the research topic, description,
 * goals, and initial questions pre-filled.
 *
 * @param options - Research note configuration
 * @returns Complete RESEARCH.md content as markdown string
 *
 * @example
 * ```typescript
 * const content = generateInitialResearchMd({
 *   topic: 'React Performance Optimization',
 *   description: 'Investigate React 19 rendering performance bottlenecks',
 *   goals: [
 *     'Identify common performance anti-patterns',
 *     'Benchmark before/after optimization',
 *   ],
 *   questions: [
 *     'How does React 19 compiler affect rendering?',
 *   ],
 * });
 * ```
 */
export function generateInitialResearchMd(options: ResearchNoteOptions): string {
  const today = new Date().toISOString().split('T')[0];
  const questions = options.questions ?? [];

  const goalsSection = options.goals
    .map(goal => `- [ ] ${goal}`)
    .join('\n');

  const questionsSection = questions.length > 0
    ? questions.map(q => `- [ ] ${q}`).join('\n')
    : '_（暂无待调查问题）_';

  return `# ${options.topic}

> ${options.description}
>
> 创建时间: ${today}
> 状态: ${RESEARCH_STATUS_MARKERS['in-progress']} ${RESEARCH_STATUS_LABELS['in-progress']}

## 研究目标

${goalsSection}

## 已收集的信息

_（暂无发现，开始研究后将自动记录）_

## 待调查的问题

${questionsSection}

## 研究结论

_（研究完成后填写）_

## 相关资源

_（研究过程中收集的相关资源）_
`;
}

/**
 * Parse research status from RESEARCH.md content.
 *
 * Extracts the status marker, topic, and creation date from
 * a RESEARCH.md file's content.
 *
 * @param content - RESEARCH.md file content
 * @returns Parsed status information, or null if status cannot be determined
 *
 * @example
 * ```typescript
 * const content = await fs.readFile('RESEARCH.md', 'utf-8');
 * const status = parseResearchStatus(content);
 * if (status) {
 *   console.log(`Topic: ${status.topic}, Status: ${status.status}`);
 * }
 * ```
 */
export function parseResearchStatus(content: string): ParsedResearchStatus | null {
  const statusMatch = content.match(STATUS_PATTERN);
  if (!statusMatch) {
    return null;
  }

  const status = EMOJI_TO_STATUS[statusMatch[1]];
  if (!status) {
    return null;
  }

  const topicMatch = content.match(TOPIC_PATTERN);
  const createdMatch = content.match(CREATED_AT_PATTERN);

  return {
    status,
    topic: topicMatch?.[1]?.trim() ?? 'Unknown',
    createdAt: createdMatch?.[1] ?? null,
  };
}

/**
 * Generate conclusion section content for archiving a completed research.
 *
 * Produces the final "## 研究结论" section to replace the placeholder
 * in RESEARCH.md when research is complete.
 *
 * @param options - Conclusion configuration
 * @returns Formatted conclusion section markdown
 *
 * @example
 * ```typescript
 * const conclusion = generateConclusionSection({
 *   coreFindings: [
 *     'React 19 compiler reduces re-renders by 40%',
 *     'Server Components provide significant FCP improvement',
 *   ],
 *   recommendations: [
 *     'Migrate to React 19 compiler for existing codebase',
 *   ],
 *   unresolvedIssues: [
 *     'Streaming SSR performance with large datasets',
 *   ],
 * });
 * ```
 */
export function generateConclusionSection(options: ResearchConclusionOptions): string {
  const sections: string[] = [];

  // Core findings (required)
  if (options.coreFindings.length > 0) {
    sections.push(
      '### 核心发现\n',
      ...options.coreFindings.map(f => `- ${f}`),
      ''
    );
  }

  // Recommendations (optional)
  if (options.recommendations && options.recommendations.length > 0) {
    sections.push(
      '### 建议\n',
      ...options.recommendations.map(r => `- ${r}`),
      ''
    );
  }

  // Unresolved issues (optional)
  if (options.unresolvedIssues && options.unresolvedIssues.length > 0) {
    sections.push(
      '### 未解决问题\n',
      ...options.unresolvedIssues.map(i => `- ${i}`),
      ''
    );
  }

  // Follow-up directions (optional)
  if (options.followUpDirections && options.followUpDirections.length > 0) {
    sections.push(
      '### 后续方向\n',
      ...options.followUpDirections.map(d => `- ${d}`),
      ''
    );
  }

  return sections.join('\n');
}

/**
 * Generate the updated header with a new status marker.
 *
 * Useful for transitioning between research states (e.g., in-progress → completed).
 *
 * @param content - Current RESEARCH.md content
 * @param newStatus - Target status
 * @returns Updated content with new status marker, or original content if pattern not found
 */
export function updateResearchStatus(content: string, newStatus: ResearchStatus): string {
  const marker = RESEARCH_STATUS_MARKERS[newStatus];
  const label = RESEARCH_STATUS_LABELS[newStatus];
  const newStatusLine = `> 状态: ${marker} ${label}`;

  // Match existing status line and replace
  return content.replace(
    /^>\s*状态:\s*🟡.*$/m,
    newStatusLine
  );
}
