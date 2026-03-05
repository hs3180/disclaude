/**
 * Primary Node modules - Extracted components for better maintainability.
 *
 * Issue #695: Split primary-node.ts into modular components.
 *
 * Modules:
 * - LocalExecutionService: AgentPool and local execution management
 * - ScheduleCommandHandler: Schedule management commands
 * - NextStepService: Next-step recommendations after task completion
 */

export { LocalExecutionService } from './local-execution-service.js';
export type { LocalExecutionServiceConfig, LocalExecutionCallbacks, FeedbackContext } from './local-execution-service.js';

export { ScheduleCommandHandler } from './schedule-command-handler.js';
export type { ScheduleCommandHandlerDeps } from './schedule-command-handler.js';

export { NextStepService, getNextStepService } from './next-step-service.js';
