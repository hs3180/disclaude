/**
 * Intent Module — Universal Intent Convergence Protocol
 *
 * Three-phase protocol for ensuring the agent fully understands
 * user intent before executing data processing tasks.
 *
 * Related: #4152
 * @module intent
 */

export type {
  FileCategory,
  WorkspaceFile,
  InferredData,
  WorkspaceScanResult,
  IntentAnalysis,
  ConvergencePrompt,
  ValidationResult,
  ValidationCheck,
  FeedbackResponse,
} from './types.js';

export { categorizeExtension, inferData, scanWorkspace } from './workspace-scanner.js';
export { analyzeIntent } from './intent-analyzer.js';
