/**
 * Survey data types and validation.
 *
 * Defines the schema for lightweight in-bot surveys with
 * single-choice questions, file-based storage, and result aggregation.
 *
 * Survey files are stored as JSON in `workspace/surveys/{surveyId}.json`.
 *
 * @module skills/survey/schema
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported question types */
export type QuestionType = 'single_choice' | 'multiple_choice' | 'text';

/** A single question in a survey */
export interface SurveyQuestion {
  /** Question ID (unique within survey, e.g. "q1") */
  id: string;
  /** Question text shown to user */
  text: string;
  /** Question type */
  type: QuestionType;
  /** Options for choice-type questions. Ignored for text type. */
  options?: string[];
}

/** A single user's response */
export interface SurveyResponse {
  /** Question ID this response is for */
  questionId: string;
  /** Selected option(s) for choice types, or free text for text type */
  value: string | string[];
}

/** Full response from one user */
export interface UserResponse {
  /** User's open_id */
  responder: string;
  /** ISO 8601 timestamp */
  repliedAt: string;
  /** Per-question responses */
  answers: SurveyResponse[];
}

/** Survey status lifecycle */
export type SurveyStatus = 'draft' | 'active' | 'closed';

/** The complete survey object persisted as JSON */
export interface Survey {
  /** Unique survey identifier (used as filename) */
  id: string;
  /** Human-readable title */
  title: string;
  /** Optional description shown above questions */
  description?: string;
  /** Current status */
  status: SurveyStatus;
  /** Whether responses are anonymous */
  anonymous: boolean;
  /** Questions */
  questions: SurveyQuestion[];
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 deadline (optional) */
  deadline?: string;
  /** Target user open_ids */
  targetUsers: string[];
  /** Collected responses */
  responses: UserResponse[];
  /** Chat ID where survey was created / results should be sent */
  sourceChatId?: string;
  /** Message ID of the survey card (set after sending) */
  cardMessageId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SURVEYS_DIR = 'workspace/surveys';

/** Valid survey ID pattern: alphanumeric, hyphens, underscores */
export const SURVEY_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the absolute path to the surveys directory, creating it if needed.
 */
export function getSurveysDir(baseDir?: string): string {
  const dir = baseDir ? join(baseDir, SURVEYS_DIR) : SURVEYS_DIR;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the file path for a specific survey.
 */
export function getSurveyPath(surveyId: string, baseDir?: string): string {
  return join(getSurveysDir(baseDir), `${surveyId}.json`);
}

/**
 * Validate a survey ID for safe filesystem usage.
 * Prevents path traversal and ensures valid characters.
 */
export function isValidSurveyId(id: string): boolean {
  return SURVEY_ID_PATTERN.test(id) && !id.startsWith('.');
}

/**
 * Validate survey data structure.
 * Returns null if valid, or an error message string.
 */
export function validateSurvey(data: unknown): string | null {
  if (!data || typeof data !== 'object') return 'Survey must be an object';
  const s = data as Record<string, unknown>;

  // Required string fields
  if (typeof s.id !== 'string' || !s.id.trim()) return 'id is required';
  if (!isValidSurveyId(s.id as string)) return 'id must match pattern: alphanumeric, hyphens, underscores (no leading dots)';
  if (typeof s.title !== 'string' || !(s.title as string).trim()) return 'title is required';

  // Status
  const validStatuses: SurveyStatus[] = ['draft', 'active', 'closed'];
  if (!validStatuses.includes(s.status as SurveyStatus)) return `status must be one of: ${validStatuses.join(', ')}`;

  // Anonymous
  if (typeof s.anonymous !== 'boolean') return 'anonymous must be a boolean';

  // Questions
  if (!Array.isArray(s.questions) || (s.questions as unknown[]).length === 0) {
    return 'questions must be a non-empty array';
  }
  for (let i = 0; i < (s.questions as unknown[]).length; i++) {
    const q = (s.questions as Record<string, unknown>[])[i];
    if (typeof q.id !== 'string' || !q.id.trim()) return `questions[${i}].id is required`;
    if (typeof q.text !== 'string' || !(q.text as string).trim()) return `questions[${i}].text is required`;
    const validTypes: QuestionType[] = ['single_choice', 'multiple_choice', 'text'];
    if (!validTypes.includes(q.type as QuestionType)) return `questions[${i}].type must be one of: ${validTypes.join(', ')}`;
    if (q.type !== 'text' && (!Array.isArray(q.options) || (q.options as unknown[]).length === 0)) {
      return `questions[${i}].options is required for choice-type questions`;
    }
  }

  // Target users
  if (!Array.isArray(s.targetUsers) || (s.targetUsers as unknown[]).length === 0) {
    return 'targetUsers must be a non-empty array of open_id strings';
  }
  for (let i = 0; i < (s.targetUsers as unknown[]).length; i++) {
    const uid = (s.targetUsers as unknown[])[i];
    if (typeof uid !== 'string' || !(uid as string).startsWith('ou_')) {
      return `targetUsers[${i}] must be an open_id starting with "ou_"`;
    }
  }

  // Responses
  if (!Array.isArray(s.responses)) return 'responses must be an array';

  // Deadline (optional but must be valid ISO 8601 if provided)
  if (s.deadline !== undefined && s.deadline !== null) {
    if (typeof s.deadline !== 'string' || isNaN(Date.parse(s.deadline as string))) {
      return 'deadline must be a valid ISO 8601 date string';
    }
  }

  return null;
}
