/**
 * Research data types for the report template rendering system.
 *
 * Issue #1339: Agentic Research - Template rendering for research reports.
 * These types define the data structure consumed by report templates.
 *
 * @module @disclaude/core/research
 */

/**
 * A single research finding with source attribution.
 */
export interface ResearchFinding {
  /** Short title of the finding */
  title: string;
  /** Detailed description */
  description: string;
  /** Source URL or reference */
  source?: string;
  /** Confidence level: high, medium, low */
  confidence?: 'high' | 'medium' | 'low';
  /** Relevant tags for categorization */
  tags?: string[];
}

/**
 * A resource link referenced in the research.
 */
export interface ResearchResource {
  /** Display name */
  name: string;
  /** URL or file path */
  url: string;
  /** Optional description */
  description?: string;
}

/**
 * Research report metadata.
 */
export interface ResearchReportMetadata {
  /** Research start time (ISO string) */
  startTime: string;
  /** Research end time (ISO string) */
  endTime?: string;
  /** Report version number (incremented on updates) */
  version: number;
  /** Optional author/agent identifier */
  author?: string;
  /** Optional template used */
  templateName?: string;
}

/**
 * Complete research report data structure.
 *
 * This is the primary input to the template rendering engine.
 * It represents the full state of a completed or in-progress research task.
 */
export interface ResearchReport {
  /** Report title */
  title: string;
  /** Research topic / question */
  topic: string;
  /** Executive summary (1-3 paragraphs) */
  summary: string;
  /** Research objectives (checklist items) */
  objectives: string[];
  /** Completed objectives (subset of objectives that are done) */
  completedObjectives?: string[];
  /** Research findings */
  findings: ResearchFinding[];
  /** Key conclusions drawn from findings */
  conclusions: string[];
  /** Actionable recommendations */
  recommendations: string[];
  /** Referenced resources */
  resources: ResearchResource[];
  /** Report metadata */
  metadata: ResearchReportMetadata;
  /** Optional: pending questions for further investigation */
  pendingQuestions?: string[];
  /** Optional: outline/structure of the research */
  outline?: ResearchOutline;
}

/**
 * Research outline section for structured research.
 */
export interface ResearchOutlineSection {
  /** Section title */
  title: string;
  /** Section description */
  description?: string;
  /** Sub-sections (recursive) */
  children?: ResearchOutlineSection[];
  /** Status: pending, in_progress, completed */
  status?: 'pending' | 'in_progress' | 'completed';
}

/**
 * Research outline for structured research tasks.
 */
export interface ResearchOutline {
  /** Version of the outline (incremented on modifications) */
  version: number;
  /** Last modified time (ISO string) */
  lastModified: string;
  /** Outline sections */
  sections: ResearchOutlineSection[];
}

/**
 * Template variable types for type-safe rendering.
 */
export type TemplateVariableType = 'string' | 'string[]' | 'number' | 'boolean' | 'date' | 'findings' | 'resources' | 'outline';
