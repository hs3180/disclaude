/**
 * Survey schema definitions and validation functions.
 *
 * Provides types, constants, and validation for the survey/poll feature.
 * No external dependencies — uses only Node.js built-ins.
 *
 * @module survey/schema
 */

// ---- Types ----

export type SurveyStatus = 'open' | 'closed';
export type QuestionType = 'single_choice' | 'text';

export interface SurveyQuestion {
  /** Unique question ID within the survey */
  id: string;
  /** Question type */
  type: QuestionType;
  /** Question text */
  question: string;
  /** Options for single_choice questions */
  options?: string[];
  /** Whether the question is required */
  required: boolean;
}

export interface SurveyResponse {
  /** Responder's open ID */
  responder: string;
  /** Timestamp of response */
  repliedAt: string;
  /** Answers keyed by question ID */
  answers: Record<string, string>;
}

export interface SurveyFile {
  /** Unique survey identifier */
  id: string;
  /** Survey title */
  title: string;
  /** Survey description */
  description: string;
  /** Survey status */
  status: SurveyStatus;
  /** Whether responses are anonymous */
  anonymous: boolean;
  /** Creation timestamp (ISO 8601 Z-suffix) */
  createdAt: string;
  /** Expiry timestamp (ISO 8601 Z-suffix) */
  expiresAt: string;
  /** Closure timestamp (set when closed) */
  closedAt: string | null;
  /** Creator's open ID */
  creator: string;
  /** Target users (open IDs) */
  targetUsers: string[];
  /** Survey questions */
  questions: SurveyQuestion[];
  /** Responses keyed by responder open ID */
  responses: Record<string, SurveyResponse>;
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const QUESTION_ID_REGEX = /^q[0-9]+$/;
export const MAX_TITLE_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_QUESTIONS = 10;
export const MAX_OPTIONS = 20;
export const MAX_OPTION_LENGTH = 64;
export const MAX_QUESTION_LENGTH = 512;
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
    throw new ValidationError('SURVEY_TITLE environment variable is required');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      `SURVEY_TITLE too long (${title.length} chars, max ${MAX_TITLE_LENGTH})`,
    );
  }
}

export function validateDescription(description: string): void {
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      `SURVEY_DESCRIPTION too long (${description.length} chars, max ${MAX_DESCRIPTION_LENGTH})`,
    );
  }
}

export function validateExpiresAt(expiresAt: string): void {
  if (!expiresAt) {
    throw new ValidationError('SURVEY_EXPIRES_AT environment variable is required');
  }
  if (!UTC_DATETIME_REGEX.test(expiresAt)) {
    throw new ValidationError(
      `SURVEY_EXPIRES_AT must be UTC Z-suffix format (e.g. 2026-04-27T10:00:00Z), got '${expiresAt}'`,
    );
  }
}

export function validateCreator(creator: string): void {
  if (!creator) {
    throw new ValidationError('SURVEY_CREATOR environment variable is required');
  }
  if (!MEMBER_ID_REGEX.test(creator)) {
    throw new ValidationError(`Invalid creator ID '${creator}' — expected ou_xxxxx format`);
  }
}

export function validateTargetUsers(users: unknown): string[] {
  if (!Array.isArray(users) || users.length === 0) {
    throw new ValidationError('SURVEY_TARGET_USERS must be a non-empty JSON array of open IDs');
  }
  if (users.length > MAX_TARGET_USERS) {
    throw new ValidationError(
      `Too many target users (${users.length}, max ${MAX_TARGET_USERS})`,
    );
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
  if (questions.length > MAX_QUESTIONS) {
    throw new ValidationError(
      `Too many questions (${questions.length}, max ${MAX_QUESTIONS})`,
    );
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as Record<string, unknown>;

    // Validate question ID
    if (typeof q.id !== 'string' || !QUESTION_ID_REGEX.test(q.id)) {
      throw new ValidationError(
        `questions[${i}].id must match ${QUESTION_ID_REGEX.toString()}, got '${q.id}'`,
      );
    }
    if (seenIds.has(q.id)) {
      throw new ValidationError(`Duplicate question ID '${q.id}'`);
    }
    seenIds.add(q.id);

    // Validate question type
    if (q.type !== 'single_choice' && q.type !== 'text') {
      throw new ValidationError(
        `questions[${i}].type must be 'single_choice' or 'text', got '${q.type}'`,
      );
    }

    // Validate question text
    if (typeof q.question !== 'string' || q.question.trim().length === 0) {
      throw new ValidationError(`questions[${i}].question must be a non-empty string`);
    }
    if ((q.question as string).length > MAX_QUESTION_LENGTH) {
      throw new ValidationError(
        `questions[${i}].question too long (${(q.question as string).length} chars, max ${MAX_QUESTION_LENGTH})`,
      );
    }

    // Validate options for single_choice
    if (q.type === 'single_choice') {
      if (!Array.isArray(q.options) || q.options.length < 2) {
        throw new ValidationError(
          `questions[${i}].options must have at least 2 options for single_choice`,
        );
      }
      if (q.options.length > MAX_OPTIONS) {
        throw new ValidationError(
          `questions[${i}].options too many (${q.options.length}, max ${MAX_OPTIONS})`,
        );
      }
      for (const opt of q.options) {
        if (typeof opt !== 'string' || opt.trim().length === 0) {
          throw new ValidationError(`questions[${i}].options contains empty option`);
        }
        if (opt.length > MAX_OPTION_LENGTH) {
          throw new ValidationError(
            `questions[${i}].options '${opt}' too long (${opt.length} chars, max ${MAX_OPTION_LENGTH})`,
          );
        }
      }
    }

    // Validate required flag
    if (typeof q.required !== 'boolean') {
      throw new ValidationError(`questions[${i}].required must be a boolean`);
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
  if (!isValidStatus(obj.status)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'status': '${obj.status}'`);
  }
  if (typeof obj.title !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has missing 'title'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'expiresAt'`);
  }
  if (typeof obj.creator !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has missing 'creator'`);
  }
  if (!Array.isArray(obj.targetUsers)) {
    throw new ValidationError(`Survey file '${filePath}' has missing 'targetUsers'`);
  }
  if (!Array.isArray(obj.questions)) {
    throw new ValidationError(`Survey file '${filePath}' has missing 'questions'`);
  }
  if (typeof obj.responses !== 'object' || obj.responses === null || Array.isArray(obj.responses)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'responses'`);
  }

  return data as SurveyFile;
}

function isValidStatus(status: unknown): status is SurveyStatus {
  return typeof status === 'string' && ['open', 'closed'].includes(status);
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}
