/**
 * Survey schema definitions and validation functions.
 *
 * Provides types and validation for the lightweight survey/polling system.
 * Follows the same patterns as skills/chat/schema.ts.
 *
 * Issue #2191: Survey/Polling feature (Phase 1 - built-in lightweight survey)
 */

// ---- Types ----

export type SurveyStatus = 'active' | 'closed';
export type QuestionType = 'single_choice' | 'multiple_choice' | 'text';

export interface SurveyQuestion {
  /** Unique question ID within the survey (e.g. "q1", "q2") */
  id: string;
  /** Question type */
  type: QuestionType;
  /** Question text */
  text: string;
  /** Options for choice-type questions */
  options?: string[];
  /** Maximum selections for multiple_choice (default: all) */
  maxSelections?: number;
}

export interface SurveyResponse {
  /** Responder's open ID */
  responder: string;
  /** When the response was submitted */
  respondedAt: string;
  /** Answers keyed by question ID */
  answers: Record<string, string | string[]>;
}

export interface SurveyFile {
  /** Unique survey identifier */
  id: string;
  /** Survey status */
  status: SurveyStatus;
  /** Survey title */
  title: string;
  /** Optional description */
  description?: string;
  /** Creation timestamp (ISO 8601 Z-suffix) */
  createdAt: string;
  /** Expiry timestamp (ISO 8601 Z-suffix) */
  expiresAt: string;
  /** Whether responses are anonymous */
  anonymous: boolean;
  /** Survey questions */
  questions: SurveyQuestion[];
  /** Target user open IDs */
  targetUsers: string[];
  /** Collected responses */
  responses: SurveyResponse[];
  /** When the survey was closed (if closed) */
  closedAt: string | null;
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const QUESTION_ID_REGEX = /^q\d+$/;
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_QUESTION_TEXT_LENGTH = 200;
export const MAX_OPTION_LENGTH = 50;
export const MAX_OPTIONS_COUNT = 10;
export const MAX_QUESTIONS_COUNT = 10;
export const MAX_TARGET_USERS = 50;
export const MAX_ANSWER_TEXT_LENGTH = 1000;

// ---- Validation helpers ----

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}

export function validateSurveyId(id: string): void {
  if (!id) {
    throw new ValidationError('SURVEY_ID is required');
  }
  if (!SURVEY_ID_REGEX.test(id)) {
    throw new ValidationError(
      `Invalid survey ID '${id}' — must start with [a-zA-Z0-9_-], only [a-zA-Z0-9._-] allowed`,
    );
  }
}

export function validateTitle(title: string): void {
  if (!title) {
    throw new ValidationError('SURVEY_TITLE is required');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      `Title too long (${title.length} chars, max ${MAX_TITLE_LENGTH})`,
    );
  }
}

export function validateDescription(desc: string): void {
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      `Description too long (${desc.length} chars, max ${MAX_DESCRIPTION_LENGTH})`,
    );
  }
}

export function validateExpiresAt(expiresAt: string): void {
  if (!expiresAt) {
    throw new ValidationError('SURVEY_EXPIRES_AT is required');
  }
  if (!UTC_DATETIME_REGEX.test(expiresAt)) {
    throw new ValidationError(
      `SURVEY_EXPIRES_AT must be UTC Z-suffix format (e.g. 2026-04-25T10:00:00Z), got '${expiresAt}'`,
    );
  }
}

export function validateTargetUsers(users: unknown): string[] {
  if (!Array.isArray(users) || users.length === 0) {
    throw new ValidationError('SURVEY_TARGET_USERS must be a non-empty JSON array of open IDs');
  }
  if (users.length > MAX_TARGET_USERS) {
    throw new ValidationError(`Too many target users (${users.length}, max ${MAX_TARGET_USERS})`);
  }
  for (const user of users) {
    if (typeof user !== 'string' || !MEMBER_ID_REGEX.test(user)) {
      throw new ValidationError(`Invalid user ID '${user}' — expected ou_xxxxx format`);
    }
  }
  return users;
}

export function validateQuestions(questions: unknown): SurveyQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ValidationError('SURVEY_QUESTIONS must be a non-empty JSON array');
  }
  if (questions.length > MAX_QUESTIONS_COUNT) {
    throw new ValidationError(`Too many questions (${questions.length}, max ${MAX_QUESTIONS_COUNT})`);
  }

  const validated: SurveyQuestion[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object') {
      throw new ValidationError(`questions[${i}] must be an object`);
    }

    // Validate id
    if (typeof q.id !== 'string' || !QUESTION_ID_REGEX.test(q.id)) {
      throw new ValidationError(`questions[${i}].id must match ${QUESTION_ID_REGEX.source} (e.g. "q1")`);
    }
    if (seenIds.has(q.id)) {
      throw new ValidationError(`Duplicate question id '${q.id}'`);
    }
    seenIds.add(q.id);

    // Validate type
    if (!['single_choice', 'multiple_choice', 'text'].includes(q.type)) {
      throw new ValidationError(`questions[${i}].type must be 'single_choice', 'multiple_choice', or 'text'`);
    }

    // Validate text
    if (typeof q.text !== 'string' || q.text.trim().length === 0) {
      throw new ValidationError(`questions[${i}].text must be a non-empty string`);
    }
    if (q.text.length > MAX_QUESTION_TEXT_LENGTH) {
      throw new ValidationError(`questions[${i}].text too long (${q.text.length}, max ${MAX_QUESTION_TEXT_LENGTH})`);
    }

    const question: SurveyQuestion = {
      id: q.id,
      type: q.type,
      text: q.text.trim(),
    };

    // Validate options for choice types
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      if (!Array.isArray(q.options) || q.options.length < 2) {
        throw new ValidationError(`questions[${i}].options must have at least 2 options for ${q.type}`);
      }
      if (q.options.length > MAX_OPTIONS_COUNT) {
        throw new ValidationError(`questions[${i}].options too many (${q.options.length}, max ${MAX_OPTIONS_COUNT})`);
      }
      for (let j = 0; j < q.options.length; j++) {
        if (typeof q.options[j] !== 'string' || q.options[j].trim().length === 0) {
          throw new ValidationError(`questions[${i}].options[${j}] must be a non-empty string`);
        }
        if (q.options[j].length > MAX_OPTION_LENGTH) {
          throw new ValidationError(`questions[${i}].options[${j}] too long (${q.options[j].length}, max ${MAX_OPTION_LENGTH})`);
        }
      }
      question.options = q.options.map((o: string) => o.trim());

      // Validate maxSelections for multiple_choice
      if (q.type === 'multiple_choice' && q.maxSelections !== undefined) {
        if (typeof q.maxSelections !== 'number' || q.maxSelections < 1 || q.maxSelections > q.options.length) {
          throw new ValidationError(
            `questions[${i}].maxSelections must be between 1 and ${q.options.length}`,
          );
        }
        question.maxSelections = q.maxSelections;
      }
    }

    validated.push(question);
  }

  return validated;
}

/** Parse and validate a survey file from JSON string */
export function parseSurveyFile(json: string, filePath: string): SurveyFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ValidationError(`Survey file '${filePath}' is not valid JSON`);
  }
  return validateSurveyFileData(data, filePath);
}

/** Validate the structure of a parsed survey file object */
export function validateSurveyFileData(data: unknown, filePath: string): SurveyFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError(`Survey file '${filePath}' is not a valid JSON object`);
  }
  const obj = data as Record<string, unknown>;

  // Required fields
  if (typeof obj.id !== 'string' || !SURVEY_ID_REGEX.test(obj.id)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'id'`);
  }
  if (!isValidStatus(obj.status)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'status': '${obj.status}'`);
  }
  if (typeof obj.title !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'title'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'expiresAt'`);
  }
  if (typeof obj.createdAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.createdAt)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'createdAt'`);
  }
  if (typeof obj.anonymous !== 'boolean') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'anonymous'`);
  }
  if (!Array.isArray(obj.questions)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'questions'`);
  }
  if (!Array.isArray(obj.targetUsers)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'targetUsers'`);
  }
  if (!Array.isArray(obj.responses)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'responses'`);
  }
  if (obj.closedAt != null && typeof obj.closedAt !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'closedAt'`);
  }

  return data as SurveyFile;
}

function isValidStatus(status: unknown): status is SurveyStatus {
  return typeof status === 'string' && ['active', 'closed'].includes(status);
}
