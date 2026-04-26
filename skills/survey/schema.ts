/**
 * Survey schema definitions and validation functions.
 *
 * Manages lightweight survey/poll data lifecycle:
 *   draft → active → closed
 *
 * Survey data is stored as JSON files in `workspace/surveys/`.
 *
 * Issue #2191: Survey/Polling feature — Approach C (built-in lightweight survey).
 */

// ---- Types ----

export type SurveyStatus = 'draft' | 'active' | 'closed';

export type QuestionType = 'single_choice' | 'multiple_choice' | 'text';

export interface SurveyQuestion {
  /** Unique question ID within the survey (e.g. "q1", "q2") */
  id: string;
  /** Question type */
  type: QuestionType;
  /** Question text displayed to the user */
  text: string;
  /** Options for single_choice / multiple_choice questions */
  options?: string[];
}

export interface SurveyResponse {
  /** Responder's open ID (or "anonymous" if anonymous mode) */
  responder: string;
  /** ISO timestamp of when the response was submitted */
  respondedAt: string;
  /** Answers keyed by question ID */
  answers: Record<string, string | string[]>;
}

export interface SurveyFile {
  /** Unique survey identifier (used as filename: `{id}.json`) */
  id: string;
  /** Survey title */
  title: string;
  /** Optional description */
  description: string;
  /** Current status */
  status: SurveyStatus;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of when survey was activated (sent to users) */
  activatedAt: string | null;
  /** ISO timestamp of when survey was manually closed */
  closedAt: string | null;
  /** ISO timestamp for automatic expiry */
  expiresAt: string;
  /** Whether responses are anonymous */
  anonymous: boolean;
  /** Target user open IDs who should respond */
  targetUsers: string[];
  /** The chat ID where the survey was created (for sending results) */
  chatId: string;
  /** Survey questions */
  questions: SurveyQuestion[];
  /** Collected responses, keyed by responder ID */
  responses: Record<string, SurveyResponse>;
}

// ---- Constants ----

/** Survey storage directory (can be overridden via SURVEY_DIR env var for testing) */
export const SURVEY_DIR = process.env.SURVEY_DIR || 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const QUESTION_ID_REGEX = /^q\d+$/;
export const USER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const MAX_TITLE_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_QUESTION_TEXT_LENGTH = 512;
export const MAX_OPTION_LENGTH = 64;
export const MAX_OPTIONS_COUNT = 10;
export const MAX_QUESTIONS_COUNT = 20;
export const MAX_TEXT_ANSWER_LENGTH = 2000;

// ---- Validation helpers ----

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validateSurveyId(id: string): void {
  if (!id) {
    throw new ValidationError('Survey ID is required');
  }
  if (!SURVEY_ID_REGEX.test(id)) {
    throw new ValidationError(
      `Invalid survey ID '${id}' — must start with [a-zA-Z0-9_-], only [a-zA-Z0-9._-] allowed`,
    );
  }
}

export function validateTitle(title: string): void {
  if (!title) {
    throw new ValidationError('Survey title is required');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      `Survey title too long (${title.length} chars, max ${MAX_TITLE_LENGTH})`,
    );
  }
}

export function validateDescription(description: string): void {
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      `Survey description too long (${description.length} chars, max ${MAX_DESCRIPTION_LENGTH})`,
    );
  }
}

export function validateQuestionType(type: string): asserts type is QuestionType {
  if (!['single_choice', 'multiple_choice', 'text'].includes(type)) {
    throw new ValidationError(
      `Invalid question type '${type}' — must be one of: single_choice, multiple_choice, text`,
    );
  }
}

export function validateQuestion(question: unknown, index: number): SurveyQuestion {
  if (!question || typeof question !== 'object' || Array.isArray(question)) {
    throw new ValidationError(`Question ${index} must be an object`);
  }
  const q = question as Record<string, unknown>;

  // Validate id
  if (typeof q.id !== 'string' || !QUESTION_ID_REGEX.test(q.id)) {
    throw new ValidationError(
      `Question ${index} has invalid 'id' — must match pattern q1, q2, etc.`,
    );
  }

  // Validate type
  validateQuestionType(q.type as string);

  // Validate text
  if (typeof q.text !== 'string' || q.text.trim().length === 0) {
    throw new ValidationError(`Question ${index} (${q.id}) must have non-empty 'text'`);
  }
  if (q.text.length > MAX_QUESTION_TEXT_LENGTH) {
    throw new ValidationError(
      `Question ${index} (${q.id}) text too long (${q.text.length} chars, max ${MAX_QUESTION_TEXT_LENGTH})`,
    );
  }

  // Validate options for choice questions
  const type = q.type as QuestionType;
  if (type === 'single_choice' || type === 'multiple_choice') {
    if (!Array.isArray(q.options) || q.options.length < 2) {
      throw new ValidationError(
        `Question ${index} (${q.id}) of type '${type}' must have at least 2 options`,
      );
    }
    if (q.options.length > MAX_OPTIONS_COUNT) {
      throw new ValidationError(
        `Question ${index} (${q.id}) has too many options (${q.options.length}, max ${MAX_OPTIONS_COUNT})`,
      );
    }
    for (let i = 0; i < q.options.length; i++) {
      if (typeof q.options[i] !== 'string' || q.options[i].trim().length === 0) {
        throw new ValidationError(
          `Question ${index} (${q.id}) option ${i} must be a non-empty string`,
        );
      }
      if (q.options[i].length > MAX_OPTION_LENGTH) {
        throw new ValidationError(
          `Question ${index} (${q.id}) option ${i} too long (${q.options[i].length} chars, max ${MAX_OPTION_LENGTH})`,
        );
      }
    }
  }

  return {
    id: q.id,
    type,
    text: q.text,
    options: type === 'text' ? undefined : (q.options as string[]),
  };
}

export function validateQuestions(questions: unknown): SurveyQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ValidationError('Questions must be a non-empty array');
  }
  if (questions.length > MAX_QUESTIONS_COUNT) {
    throw new ValidationError(
      `Too many questions (${questions.length}, max ${MAX_QUESTIONS_COUNT})`,
    );
  }

  const validated: SurveyQuestion[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < questions.length; i++) {
    const q = validateQuestion(questions[i], i);
    if (seenIds.has(q.id)) {
      throw new ValidationError(`Duplicate question ID '${q.id}'`);
    }
    seenIds.add(q.id);
    validated.push(q);
  }
  return validated;
}

export function validateTargetUsers(users: unknown): string[] {
  if (!Array.isArray(users) || users.length === 0) {
    throw new ValidationError('targetUsers must be a non-empty array of open IDs');
  }
  for (const user of users) {
    if (typeof user !== 'string' || !USER_ID_REGEX.test(user)) {
      throw new ValidationError(`Invalid user ID '${user}' — expected ou_xxxxx format`);
    }
  }
  return users;
}

export function validateExpiresAt(expiresAt: string): void {
  if (!expiresAt) {
    throw new ValidationError('expiresAt is required');
  }
  if (!UTC_DATETIME_REGEX.test(expiresAt)) {
    throw new ValidationError(
      `expiresAt must be UTC Z-suffix format (e.g. 2026-04-28T10:00:00Z), got '${expiresAt}'`,
    );
  }
}

export function validateAnswer(
  question: SurveyQuestion,
  answer: unknown,
): string | string[] {
  if (question.type === 'text') {
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      throw new ValidationError(`Answer for '${question.id}' must be non-empty text`);
    }
    if (answer.length > MAX_TEXT_ANSWER_LENGTH) {
      throw new ValidationError(
        `Answer for '${question.id}' too long (${answer.length} chars, max ${MAX_TEXT_ANSWER_LENGTH})`,
      );
    }
    return answer;
  }

  if (question.type === 'single_choice') {
    if (typeof answer !== 'string') {
      throw new ValidationError(`Answer for '${question.id}' must be a string (single choice)`);
    }
    if (!question.options?.includes(answer)) {
      throw new ValidationError(
        `Answer '${answer}' for '${question.id}' is not a valid option`,
      );
    }
    return answer;
  }

  // multiple_choice
  if (!Array.isArray(answer) || answer.length === 0) {
    throw new ValidationError(`Answer for '${question.id}' must be a non-empty array (multiple choice)`);
  }
  for (const item of answer) {
    if (typeof item !== 'string') {
      throw new ValidationError(`Each answer for '${question.id}' must be a string`);
    }
    if (!question.options?.includes(item)) {
      throw new ValidationError(`Answer '${item}' for '${question.id}' is not a valid option`);
    }
  }
  return answer;
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

  // Required string fields
  if (typeof obj.id !== 'string' || !SURVEY_ID_REGEX.test(obj.id)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'id'`);
  }
  if (typeof obj.title !== 'string' || obj.title.trim().length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has missing 'title'`);
  }
  if (!isValidStatus(obj.status)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'status': '${obj.status}'`);
  }
  if (typeof obj.chatId !== 'string' || obj.chatId.trim().length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has missing 'chatId'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'expiresAt'`);
  }

  // Validate questions
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has missing or empty 'questions'`);
  }

  // Validate targetUsers
  if (!Array.isArray(obj.targetUsers) || obj.targetUsers.length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has missing or empty 'targetUsers'`);
  }

  // Validate responses is an object
  if (typeof obj.responses !== 'object' || obj.responses === null || Array.isArray(obj.responses)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'responses'`);
  }

  // Validate anonymous boolean
  if (typeof obj.anonymous !== 'boolean') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'anonymous'`);
  }

  return data as SurveyFile;
}

function isValidStatus(status: unknown): status is SurveyStatus {
  return typeof status === 'string' && ['draft', 'active', 'closed'].includes(status);
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}
