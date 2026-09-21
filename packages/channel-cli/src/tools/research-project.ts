/** Internal agent-facing bridge for Project-scoped Research operations. */

import { createLogger, researchProject as callResearchProject } from '@disclaude/core';
import {
  buildChannelApiFallbackHint,
  getChannelApiClient,
  getChannelApiErrorMessage,
  isChannelApiAvailable,
} from './channel-api-utils.js';

const logger = createLogger('ResearchProject');

export interface ResearchProjectToolResult {
  success: boolean;
  message: string;
  project?: Record<string, unknown>;
  projects?: Array<Record<string, unknown>>;
  error?: string;
}

export async function research_project(params: {
  context: string;
  operation: unknown;
}): Promise<ResearchProjectToolResult> {
  if (!params.context?.trim()) {
    return {
      success: false,
      message: 'Research context is required.',
      error: 'context is required',
    };
  }
  if (!(await isChannelApiAvailable())) {
    const message = `REST API service unavailable.${buildChannelApiFallbackHint()}`;
    return { success: false, message, error: message };
  }
  try {
    const result = await callResearchProject(
      getChannelApiClient(),
      params.context,
      params.operation
    );
    if (!result.success) {
      const message = getChannelApiErrorMessage(result.errorType, result.error);
      return { success: false, message, error: result.error };
    }
    return {
      success: true,
      message: result.message ?? 'Research operation accepted.',
      project: result.project,
      projects: result.projects,
    };
  } catch (error) {
    logger.error({ err: error }, 'research_project failed');
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Research operation failed: ${message}`, error: message };
  }
}
