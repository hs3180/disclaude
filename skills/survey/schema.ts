/**
 * Survey schema definitions and validation functions.
 *
 * Defines the data model for surveys and provides validation helpers
 * used by create.ts, query.ts, respond.ts, and list.ts scripts.
 */

// ---- Types ----

export type SurveyStatus = 'open' | 'closed';
export type QuestionType = 'single_choice' | 'multiple_choice' | 'text';

export interface SurveyQuestion {
  /** Unique question ID within the survey (e.g. "q1") */
  id: string;
  /** Question type */
  type: QuestionType;
  /** Question text displayed to user */
  text: string;
  /** Options for choice-type questions */
  options?: string[];
  /** Whether the question must be answered */
  required?: boolean;
}

export interface SurveyResponseAnswer {
  /** Answer value: selected option text, or free-form text */
  [questionId: string]: string;
}

export interface SurveyResponse {
  /** Responder's open ID */
  responder: string;
  /** ISO 8601 timestamp when response was submitted */
  answeredAt: string;
  /** Answers keyed by question ID */
  answers: SurveyResponseAnswer;
}

export interface SurveyFile {
  /** Unique survey identifier */
  id: string;
  /** Survey title */
  title: string;
  /** Optional description */
  description?: string;
  /** Survey status: open or closed */
  status: SurveyStatus;
  /** Whether responses are anonymous */
  anonymous: boolean;
  /** ISO 8601 Z-suffix expiry timestamp */
  expiresAt: string;
  /** ISO 8601 Z-suffix creation timestamp */
  createdAt: string;
  /** Target user open IDs */
  targetUsers: string[];
  /** Survey questions */
  questions: SurveyQuestion[];
  /** Responses keyed by responder open ID (or anonymous hash) */
  responses: Record<string, SurveyResponse>;
  /** Chat ID where the survey was initiated */
  chatId: string;
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const QUESTION_ID_REGEX = /^q\d+$/;
export const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const MAX_TITLE_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 512;
export const MAX_QUESTION_TEXT_LENGTH = 256;
export const MAX_OPTION_LENGTH = 64;
export const MAX_OPTION_COUNT = 10;
export const MAX_QUESTION_COUNT = 20;
export const MAX_ANSWER_LENGTH = 2000;
export const MAX_TARGET_USERS = 50;

// ---- Validation helpers ----

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
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
    throw new ValidationError(`Title too long (${title.length} chars, max ${MAX_TITLE_LENGTH})`);
  }
}

export function validateDescription(desc: string | undefined): void {
  if (desc !== undefined && desc.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Description too long (${desc.length} chars, max ${MAX_DESCRIPTION_LENGTH})`);
  }
}

export function validateExpiresAt(expiresAt: string): void {
  if (!expiresAt) {
    throw new ValidationError('SURVEY_EXPIRES_AT is required');
  }
  if (!UTC_DATETIME_REGEX.test(expiresAt)) {
    throw new ValidationError(
      `SURVEY_EXPIRES_AT must be UTC Z-suffix format (e.g. 2026-04-20T10:00:00Z), got '${expiresAt}'`,
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
  if (questions.length > MAX_QUESTION_COUNT) {
    throw new ValidationError(`Too many questions (${questions.length}, max ${MAX_QUESTION_COUNT})`);
  }

  const validated: SurveyQuestion[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object') {
      throw new ValidationError(`questions[${i}] must be an object`);
    }

    const qObj = q as Record<string, unknown>;

    // Validate id
    const id = qObj.id;
    if (typeof id !== 'string' || !QUESTION_ID_REGEX.test(id)) {
      throw new ValidationError(`questions[${i}].id must match pattern q1, q2, ... (got '${id}')`);
    }
    if (seenIds.has(id)) {
      throw new ValidationError(`Duplicate question id '${id}'`);
    }
    seenIds.add(id);

    // Validate type
    const type = qObj.type;
    if (type !== 'single_choice' && type !== 'multiple_choice' && type !== 'text') {
      throw new ValidationError(
        `questions[${i}].type must be 'single_choice', 'multiple_choice', or 'text' (got '${type}')`,
      );
    }

    // Validate text
    const text = qObj.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ValidationError(`questions[${i}].text must be a non-empty string`);
    }
    if (text.length > MAX_QUESTION_TEXT_LENGTH) {
      throw new ValidationError(`questions[${i}].text too long (${text.length} chars, max ${MAX_QUESTION_TEXT_LENGTH})`);
    }

    // Validate options for choice types
    if (type === 'single_choice' || type === 'multiple_choice') {
      const options = qObj.options;
      if (!Array.isArray(options) || options.length === 0) {
        throw new ValidationError(`questions[${i}].options is required for choice type and must be non-empty`);
      }
      if (options.length > MAX_OPTION_COUNT) {
        throw new ValidationError(`questions[${i}].options too many (${options.length}, max ${MAX_OPTION_COUNT})`);
      }
      for (const opt of options) {
        if (typeof opt !== 'string' || opt.trim().length === 0) {
          throw new ValidationError(`questions[${i}].options contains non-string or empty value`);
        }
        if (opt.length > MAX_OPTION_LENGTH) {
          throw new ValidationError(`questions[${i}].options value too long ('${opt}', max ${MAX_OPTION_LENGTH})`);
        }
      }
    }

    validated.push({
      id,
      type,
      text,
      options: qObj.options as string[] | undefined,
      required: qObj.required === true,
    });
  }

  return validated;
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
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
  if (typeof obj.title !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has missing 'title'`);
  }
  if (obj.status !== 'open' && obj.status !== 'closed') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'status': '${obj.status}'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'expiresAt'`);
  }
  if (typeof obj.createdAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.createdAt)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'createdAt'`);
  }
  if (!Array.isArray(obj.targetUsers)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'targetUsers'`);
  }
  if (!Array.isArray(obj.questions)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'questions'`);
  }
  if (!obj.responses || typeof obj.responses !== 'object' || Array.isArray(obj.responses)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'responses'`);
  }

  return data as SurveyFile;
}
