/**
 * Research module - Report template rendering system.
 *
 * Issue #1339: Agentic Research - Template rendering for research reports.
 *
 * This module provides:
 * - ResearchReportRenderer: Template-based report rendering engine
 * - Built-in templates: summary, detailed, technical, briefing
 * - Custom template loading from file system
 * - Type definitions for research data structures
 *
 * @module @disclaude/core/research
 */

// Types
export type {
  ResearchReport,
  ResearchFinding,
  ResearchResource,
  ResearchReportMetadata,
  ResearchOutline,
  ResearchOutlineSection,
  TemplateVariableType,
} from './types.js';

// Template types
export type {
  ReportTemplate,
  TemplateVariable,
  BuiltinTemplateType,
  RenderContext,
  RenderResult,
  RendererOptions,
} from './template-types.js';

// Core renderer
export { ReportRenderer } from './report-renderer.js';

// Built-in templates
export {
  getBuiltinTemplate,
  getAllBuiltinTemplates,
  isBuiltinTemplate,
  listBuiltinTemplateTypes,
} from './builtin-templates.js';
