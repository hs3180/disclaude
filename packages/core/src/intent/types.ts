/**
 * Intent Convergence Protocol — Types
 *
 * Defines the core interfaces for the three-phase intent convergence protocol:
 *   Phase 1: Intent convergence (workspace scan → data inference → user confirmation)
 *   Phase 2: Execution + self-validation
 *   Phase 3: Feedback response protocol
 *
 * Related: #4152
 * @module intent
 */

/** A file discovered during workspace scanning. */
export interface WorkspaceFile {
  /** Relative path from workspace root */
  relativePath: string;
  /** File extension (e.g., "csv", "json", "ts") */
  extension: string;
  /** Estimated MIME type category */
  category: FileCategory;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  modifiedAt: Date;
}

/** High-level file category for data inference. */
export type FileCategory =
  | 'structured-data'  // csv, tsv, json, yaml, xml
  | 'code'             // ts, js, py, java, etc.
  | 'document'         // md, txt, doc, pdf
  | 'config'           // toml, ini, env, conf
  | 'media'            // png, jpg, mp4, etc.
  | 'archive'          // zip, tar, gz
  | 'unknown';

/** Inferred data structure from a workspace file. */
export interface InferredData {
  /** File that was analyzed */
  file: WorkspaceFile;
  /** Inferred data type (e.g., "table", "key-value", "array") */
  dataType: string;
  /** Number of rows / entries (if applicable) */
  rowCount?: number;
  /** Detected column headers (for tabular data) */
  columns?: string[];
  /** Key names (for JSON/key-value data) */
  keys?: string[];
  /** Confidence level of the inference (0-1) */
  confidence: number;
}

/** Result of workspace scanning. */
export interface WorkspaceScanResult {
  /** All files found in the workspace */
  files: WorkspaceFile[];
  /** Files with data inference results */
  dataFiles: InferredData[];
  /** Summary for user confirmation */
  summary: string;
}

/** Intent analysis result — determines if convergence is needed. */
export interface IntentAnalysis {
  /** Whether the user's request involves data processing */
  isDataProcessingTask: boolean;
  /** Detected data format hints from user message (e.g., "CSV", "Excel") */
  dataHints: string[];
  /** Whether intent convergence flow should be triggered */
  needsConvergence: boolean;
  /** Reason for the decision */
  reason: string;
}

/** Phase 1 convergence result — what to show the user for confirmation. */
export interface ConvergencePrompt {
  /** Summary of discovered workspace files relevant to the task */
  discoveredFiles: InferredData[];
  /** Suggested interpretation of user intent */
  interpretedIntent: string;
  /** Questions for the user (if any ambiguity remains) */
  questions: string[];
  /** Formatted confirmation message for the user */
  confirmationMessage: string;
}

/** Phase 2 self-validation result. */
export interface ValidationResult {
  /** Whether validation passed */
  passed: boolean;
  /** Validation checks performed */
  checks: ValidationCheck[];
  /** Overall assessment */
  summary: string;
}

/** A single validation check. */
export interface ValidationCheck {
  /** Check name (e.g., "row-count-match") */
  name: string;
  /** Whether this check passed */
  passed: boolean;
  /** Human-readable description */
  description: string;
  /** Optional detail (e.g., expected vs actual count) */
  detail?: string;
}

/** Phase 3 feedback response. */
export interface FeedbackResponse {
  /** Whether feedback was actionable */
  isActionable: boolean;
  /** Extracted specific complaint (e.g., "金额计算错误") */
  specificIssue?: string;
  /** Suggested clarification question for the user */
  clarificationQuestion?: string;
}
