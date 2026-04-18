/**
 * Survey schema definitions and validation functions.
 *
 * Provides types, constants, and validators for the lightweight
 * in-bot survey system (Approach C from #2191).
 *
 * No external dependencies — uses only Node.js built-ins.
 */

// ---- Types ----

export type SurveyStatus = 'draft' | 'active' | 'closed';
export type QuestionType = 'single_choice' | 'multiple_choice' | 'text';

export interface SurveyOption {
  id: string;
  label: string;
}

export interface SurveyQuestion {
  id: string;
  type: QuestionType;
  question: string;
  options?: SurveyOption[];
  required: boolean;
}

export interface SurveyResponse {
  respondent: string;
  submittedAt: string;
  answers: Record<string, string | string[]>;
}

export interface SurveyFile {
  id: string;
  title: string;
  description: string;
  status: SurveyStatus;
  anonymous: boolean;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  targetUsers: string[];
  questions: SurveyQuestion[];
  responses: Record<string, SurveyResponse>;
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const USER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const ANON_ID_REGEX = /^anon_[a-zA-Z0-9]+$/;
export const QUESTION_ID_REGEX = /^q\d+$/;
export const OPTION_ID_REGEX = /^opt\d+$/;
export const MAX_TITLE_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_QUESTION_LENGTH = 512;
export const MAX_OPTION_LABEL_LENGTH = 64;
export const MAX_QUESTIONS = 20;
export const MAX_OPTIONS_PER_QUESTION = 10;
export const MAX_TARGET_USERS = 100;
export const MAX_TEXT_ANSWER_LENGTH = 2000;
export const MAX_RESPONSES_SIZE = 512 * 1024; // 512KB max for entire responses object

// ---- Validation ----

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
    throw new ValidationError('SURVEY_TITLE is required');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`SURVEY_TITLE too long (${title.length} chars, max ${MAX_TITLE_LENGTH})`);
  }
}

export function validateDescription(description: string): void {
  if (!description) {
    throw new ValidationError('SURVEY_DESCRIPTION is required');
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`SURVEY_DESCRIPTION too long (${description.length} chars, max ${MAX_DESCRIPTION_LENGTH})`);
  }
}

export function validateExpiresAt(expiresAt: string): void {
  if (!expiresAt) {
    throw new ValidationError('SURVEY_EXPIRES_AT is required');
  }
  if (!UTC_DATETIME_REGEX.test(expiresAt)) {
    throw new ValidationError(
      `SURVEY_EXPIRES_AT must be UTC Z-suffix format (e.g. 2026-04-25T12:00:00Z), got '${expiresAt}'`,
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
    if (typeof user !== 'string' || !USER_ID_REGEX.test(user)) {
      throw new ValidationError(`Invalid target user ID '${user}' — expected ou_xxxxx format`);
    }
  }
  return users;
}

export function validateQuestions(questions: unknown): SurveyQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ValidationError('SURVEY_QUESTIONS must be a non-empty JSON array');
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new ValidationError(`Too many questions (${questions.length}, max ${MAX_QUESTIONS})`);
  }

  const validated: SurveyQuestion[] = [];
  const questionIds = new Set<string>();

  for (const q of questions) {
    if (!q || typeof q !== 'object') {
      throw new ValidationError('Each question must be a JSON object');
    }
    const obj = q as Record<string, unknown>;

    // id
    if (typeof obj.id !== 'string' || !QUESTION_ID_REGEX.test(obj.id)) {
      throw new ValidationError(`Invalid question ID '${obj.id}' — must match pattern q1, q2, etc.`);
    }
    if (questionIds.has(obj.id)) {
      throw new ValidationError(`Duplicate question ID '${obj.id}'`);
    }
    questionIds.add(obj.id);

    // type
    if (!['single_choice', 'multiple_choice', 'text'].includes(obj.type as string)) {
      throw new ValidationError(`Invalid question type '${obj.type}' — must be single_choice, multiple_choice, or text`);
    }

    // question text
    if (typeof obj.question !== 'string' || obj.question.length === 0) {
      throw new ValidationError(`Question '${obj.id}' must have non-empty 'question' text`);
    }
    if ((obj.question as string).length > MAX_QUESTION_LENGTH) {
      throw new ValidationError(`Question '${obj.id}' text too long (max ${MAX_QUESTION_LENGTH} chars)`);
    }

    // required
    if (typeof obj.required !== 'boolean') {
      throw new ValidationError(`Question '${obj.id}' must have boolean 'required' field`);
    }

    const question: SurveyQuestion = {
      id: obj.id,
      type: obj.type as QuestionType,
      question: obj.question as string,
      required: obj.required as boolean,
    };

    // options (required for choice types)
    if (obj.type === 'single_choice' || obj.type === 'multiple_choice') {
      if (!Array.isArray(obj.options) || obj.options.length < 2) {
        throw new ValidationError(`Question '${obj.id}' of type '${obj.type}' must have at least 2 options`);
      }
      if (obj.options.length > MAX_OPTIONS_PER_QUESTION) {
        throw new ValidationError(`Question '${obj.id}' has too many options (${obj.options.length}, max ${MAX_OPTIONS_PER_QUESTION})`);
      }
      const optIds = new Set<string>();
      question.options = [];
      for (const opt of obj.options) {
        if (!opt || typeof opt !== 'object') {
          throw new ValidationError(`Option in question '${obj.id}' must be a JSON object`);
        }
        const o = opt as Record<string, unknown>;
        if (typeof o.id !== 'string' || !OPTION_ID_REGEX.test(o.id)) {
          throw new ValidationError(`Invalid option ID '${o.id}' in question '${obj.id}' — must match opt1, opt2, etc.`);
        }
        if (optIds.has(o.id)) {
          throw new ValidationError(`Duplicate option ID '${o.id}' in question '${obj.id}'`);
        }
        optIds.add(o.id);
        if (typeof o.label !== 'string' || o.label.length === 0) {
          throw new ValidationError(`Option '${o.id}' in question '${obj.id}' must have non-empty 'label'`);
        }
        if (o.label.length > MAX_OPTION_LABEL_LENGTH) {
          throw new ValidationError(`Option '${o.id}' label too long (max ${MAX_OPTION_LABEL_LENGTH} chars)`);
        }
        question.options.push({ id: o.id, label: o.label });
      }
    }

    validated.push(question);
  }

  return validated;
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format (without milliseconds) */
export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
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
  if (!['draft', 'active', 'closed'].includes(obj.status as string)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'status': '${obj.status}'`);
  }
  if (typeof obj.title !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'title'`);
  }
  if (typeof obj.description !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'description'`);
  }
  if (typeof obj.anonymous !== 'boolean') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'anonymous' field`);
  }
  if (typeof obj.createdAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.createdAt)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'createdAt'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'expiresAt'`);
  }
  if (!Array.isArray(obj.questions)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'questions'`);
  }
  if (!Array.isArray(obj.targetUsers)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'targetUsers'`);
  }
  if (typeof obj.responses !== 'object' || Array.isArray(obj.responses)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'responses'`);
  }

  return data as SurveyFile;
}
