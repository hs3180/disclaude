/**
 * Task Plan Extractor - Extracts structured task plans from Manager agent output.
 *
 * This module is responsible for parsing Manager output and extracting
 * structured task plan data including title, description, and milestones.
 */

/**
 * Task plan data extracted from manager agent output.
 */
export interface TaskPlanData {
  taskId: string;
  title: string;
  description: string;
  milestones: string[];
  originalRequest: string;
  createdAt: string;
}

/**
 * Configuration for task plan extraction.
 */
export interface TaskPlanExtractorConfig {
  /** Optional: custom task ID generator */
  generateTaskId?: () => string;
}

/**
 * Extracts structured task plans from Manager agent output.
 *
 * This class analyzes Manager output text and extracts:
 * - Task title (from markdown headers)
 * - Milestones (from numbered/bullet lists)
 * - Description (truncated output)
 */
export class TaskPlanExtractor {
  private readonly generateTaskId: () => string;

  constructor(config?: TaskPlanExtractorConfig) {
    this.generateTaskId = config?.generateTaskId || this.defaultGenerateTaskId;
  }

  /**
   * Extract task plan from manager agent output.
   * Looks for structured plan sections in the output.
   *
   * @param output - The Manager agent's output text
   * @param originalRequest - The original user request (for context)
   * @returns Extracted task plan data, or null if extraction failed
   */
  extract(output: string, originalRequest: string): TaskPlanData | null {
    const lines = output.split('\n');

    const title = this.extractTitle(lines);
    const milestones = this.extractMilestones(lines);
    const description = this.buildDescription(output, milestones);

    return {
      taskId: this.generateTaskId(),
      title,
      description,
      milestones,
      originalRequest,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Extract title from markdown headers.
   *
   * @param lines - Array of text lines
   * @returns The extracted title, or 'Untitled Task' if not found
   */
  private extractTitle(lines: string[]): string {
    // Try to extract title from headers
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') && trimmed.length > 2) {
        return trimmed.replace(/^#+\s*/, '').trim();
      }
    }
    return 'Untitled Task';
  }

  /**
   * Extract milestones from numbered lists or bullet points.
   *
   * @param lines - Array of text lines
   * @returns Array of milestone strings
   */
  private extractMilestones(lines: string[]): string[] {
    const milestones: string[] = [];
    let inMilestones = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Check if this is a list item
      const isListItem = /^\d+\./.test(trimmed) || /^[-*]/.test(trimmed);

      // Check for milestone/step/plan section headers (but not list items themselves)
      if (!isListItem && (
          trimmed.toLowerCase().includes('milestone') ||
          trimmed.toLowerCase().includes('step') ||
          trimmed.toLowerCase().includes('plan'))) {
        inMilestones = true;
        continue;
      }

      // Extract list items when in milestones section or if line looks like a list item
      if (inMilestones || isListItem) {
        const milestone = trimmed.replace(/^\d+\.?\s*/, '').replace(/^[-*]\s*/, '').trim();
        if (milestone && !milestone.startsWith('#')) {
          milestones.push(milestone);
        }
      }
    }

    return milestones;
  }

  /**
   * Build description from output text.
   *
   * @param output - Full output text
   * @param milestones - Extracted milestones (affects description length)
   * @returns Truncated description
   */
  private buildDescription(output: string, milestones: string[]): string {
    // If milestones were found, use shorter description
    // Otherwise, use longer description as context
    const maxLength = milestones.length === 0 ? 1000 : 500;
    return output.substring(0, maxLength);
  }

  /**
   * Generate a unique task ID.
   *
   * @returns A unique task ID string
   */
  private defaultGenerateTaskId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `dialogue-task-${timestamp}-${random}`;
  }
}
