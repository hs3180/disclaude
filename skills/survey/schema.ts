/**
 * Survey schema definitions and validation functions.
 *
 * Provides types, constants, and validation for survey/poll data
 * used by the survey skill scripts. Follows the pattern from
 * skills/chat/schema.ts.
 *
 * @module skills/survey/schema
 */

// ---- Types ----

export type SurveyStatus = 'active' | 'closed';
export type QuestionType = 'single_choice' | 'multiple_choice' | 'text';

export interface SurveyQuestion {
  /** Unique question identifier within the survey (e.g. "q1") */
  id: string;
  /** Question type */
  type: QuestionType;
  /** Question text displayed to users */
  text: string;
  /** Options for choice-type questions */
  options?: string[];
  /** Whether the question is required */
  required?: boolean;
}

export interface SurveyResponse {
  /** ISO 8601 timestamp when the response was submitted */
  respondedAt: string;
  /** Answers keyed by question ID */
  answers: Record<string, string | string[]>;
}

export interface SurveyFile {
  /** Unique survey identifier */
  id: string;
  /** Survey title */
  title: string;
  /** Survey description */
  description?: string;
  /** Survey status */
  status: SurveyStatus;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 close timestamp (set when survey is closed) */
  closedAt: string | null;
  /** ISO 8601 deadline (survey auto-closes after this) */
  deadline: string | null;
  /** Whether responses are anonymous */
  anonymous: boolean;
  /** Target user open IDs */
  targetUsers: string[];
  /** Survey questions */
  questions: SurveyQuestion[];
  /** Responses keyed by user open ID (or anonymized key) */
  responses: Record<string, SurveyResponse>;
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const QUESTION_ID_REGEX = /^q\d+$/;
export const MAX_TITLE_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_QUESTION_TEXT_LENGTH = 512;
export const MAX_OPTION_LENGTH = 64;
export const MAX_OPTIONS_COUNT = 20;
export const MAX_QUESTIONS_COUNT = 20;
export const MAX_ANSWER_LENGTH = 2000;

// ---- Validation helpers ----

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validateSurveyId(id: string): void {
  if (!id) {
    throw new ValidationError('SURVEY_ID environment variable is required');
  }
  if (!SURVEY_ID_REGEX.test(id)) {
    throw new ValidationError(
      `Invalid survey ID '${id}' — must start with [a-zA-Z0-9_-], only [a-zA-Z0-9._-] allowed`,
    );
  }
}

export function validateTitle(title: string): void {
  if (!title) {
    throw new ValidationError('Title is required');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      `Title too long (${title.length} chars, max ${MAX_TITLE_LENGTH})`,
    );
  }
}

export function validateDescription(desc: string | undefined): void {
  if (desc !== undefined && desc.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      `Description too long (${desc.length} chars, max ${MAX_DESCRIPTION_LENGTH})`,
    );
  }
}

export function validateDeadline(deadline: string | undefined): void {
  if (!deadline) return;
  if (!UTC_DATETIME_REGEX.test(deadline)) {
    throw new ValidationError(
      `Deadline must be UTC Z-suffix format (e.g. 2026-04-20T10:00:00Z), got '${deadline}'`,
    );
  }
}

export function validateTargetUsers(users: unknown): string[] {
  if (!Array.isArray(users) || users.length === 0) {
    throw new ValidationError('targetUsers must be a non-empty JSON array of open IDs');
  }
  for (const user of users) {
    if (typeof user !== 'string' || !MEMBER_ID_REGEX.test(user)) {
      throw new ValidationError(`Invalid target user ID '${user}' — expected ou_xxxxx format`);
    }
  }
  return users;
}

export function validateQuestions(questions: unknown): SurveyQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ValidationError('questions must be a non-empty JSON array');
  }
  if (questions.length > MAX_QUESTIONS_COUNT) {
    throw new ValidationError(
      `Too many questions (${questions.length}, max ${MAX_QUESTIONS_COUNT})`,
    );
  }

  const ids = new Set<string>();
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object') {
      throw new ValidationError(`questions[${i}] must be an object`);
    }

    // Validate id
    if (typeof q.id !== 'string' || !QUESTION_ID_REGEX.test(q.id)) {
      throw new ValidationError(
        `questions[${i}].id must match pattern q1, q2, ... (got '${q.id}')`,
      );
    }
    if (ids.has(q.id)) {
      throw new ValidationError(`Duplicate question id '${q.id}'`);
    }
    ids.add(q.id);

    // Validate type
    if (!['single_choice', 'multiple_choice', 'text'].includes(q.type)) {
      throw new ValidationError(
        `questions[${i}].type must be single_choice, multiple_choice, or text (got '${q.type}')`,
      );
    }

    // Validate text
    if (typeof q.text !== 'string' || q.text.trim().length === 0) {
      throw new ValidationError(`questions[${i}].text must be a non-empty string`);
    }
    if (q.text.length > MAX_QUESTION_TEXT_LENGTH) {
      throw new ValidationError(
        `questions[${i}].text too long (${q.text.length} chars, max ${MAX_QUESTION_TEXT_LENGTH})`,
      );
    }

    // Validate options for choice types
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      if (!Array.isArray(q.options) || q.options.length < 2) {
        throw new ValidationError(
          `questions[${i}].options must have at least 2 options for choice type`,
        );
      }
      if (q.options.length > MAX_OPTIONS_COUNT) {
        throw new ValidationError(
          `questions[${i}].options too many (${q.options.length}, max ${MAX_OPTIONS_COUNT})`,
        );
      }
      for (let j = 0; j < q.options.length; j++) {
        if (typeof q.options[j] !== 'string' || q.options[j].trim().length === 0) {
          throw new ValidationError(`questions[${i}].options[${j}] must be a non-empty string`);
        }
        if (q.options[j].length > MAX_OPTION_LENGTH) {
          throw new ValidationError(
            `questions[${i}].options[${j}] too long (${q.options[j].length} chars, max ${MAX_OPTION_LENGTH})`,
          );
        }
      }
    }

    // Validate required field
    if (q.required !== undefined && typeof q.required !== 'boolean') {
      throw new ValidationError(`questions[${i}].required must be a boolean if provided`);
    }
  }

  return questions as SurveyQuestion[];
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
  if (typeof obj.title !== 'string' || obj.title.trim().length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'title'`);
  }
  if (!isValidStatus(obj.status)) {
    throw new ValidationError(
      `Survey file '${filePath}' has invalid 'status': '${obj.status}'`,
    );
  }
  if (typeof obj.createdAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.createdAt)) {
    throw new ValidationError(
      `Survey file '${filePath}' has missing or invalid 'createdAt'`,
    );
  }

  // Optional fields with type checks
  if (obj.closedAt != null && typeof obj.closedAt !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'closedAt'`);
  }
  if (obj.deadline != null && typeof obj.deadline !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'deadline'`);
  }
  if (typeof obj.anonymous !== 'boolean') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'anonymous' (must be boolean)`);
  }

  // Validate targetUsers
  if (!Array.isArray(obj.targetUsers)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'targetUsers'`);
  }

  // Validate questions
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'questions'`);
  }

  // Validate responses
  if (!obj.responses || typeof obj.responses !== 'object' || Array.isArray(obj.responses)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'responses'`);
  }

  return data as SurveyFile;
}

function isValidStatus(status: unknown): status is SurveyStatus {
  return typeof status === 'string' && ['active', 'closed'].includes(status);
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format (without milliseconds) */
export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
