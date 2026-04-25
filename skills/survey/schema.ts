/**
 * Survey schema definitions and validation functions.
 *
 * Implements the data model and validation for the Survey/Polling feature (Issue #2191).
 * Follows the same patterns as skills/chat/schema.ts.
 *
 * No external dependencies — uses only Node.js built-ins.
 */

// ---- Types ----

export type SurveyStatus = 'active' | 'closed' | 'expired';

export type QuestionType = 'single_choice' | 'multiple_choice' | 'open_text';

export interface SurveyQuestion {
  id: string;
  type: QuestionType;
  text: string;
  options?: string[]; // Required for single_choice and multiple_choice
}

export interface SurveyResponse {
  respondedAt: string;
  answers: Record<string, string | string[]>;
}

export interface SurveyFile {
  id: string;
  title: string;
  status: SurveyStatus;
  anonymous: boolean;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  questions: SurveyQuestion[];
  targetUsers: string[];
  originChatId: string | null;
  responses: Record<string, SurveyResponse>;
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const QUESTION_ID_REGEX = /^q\d+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const MAX_TITLE_LENGTH = 128;
export const MAX_QUESTION_TEXT_LENGTH = 512;
export const MAX_OPTIONS = 20;
export const MAX_OPTION_LENGTH = 64;
export const MAX_QUESTIONS = 20;
export const MAX_OPEN_TEXT_LENGTH = 2000;
export const MAX_TARGET_USERS = 100;

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

export function validateExpiresAt(expiresAt: string): void {
  if (!expiresAt) {
    throw new ValidationError('SURVEY_EXPIRES_AT environment variable is required');
  }
  if (!UTC_DATETIME_REGEX.test(expiresAt)) {
    throw new ValidationError(
      `SURVEY_EXPIRES_AT must be UTC Z-suffix format (e.g. 2026-04-28T10:00:00Z), got '${expiresAt}'`,
    );
  }
  const now = new Date();
  const expiry = new Date(expiresAt);
  if (expiry <= now) {
    console.error(`WARN: SURVEY_EXPIRES_AT '${expiresAt}' is already in the past (now: ${nowISO()})`);
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
  const seenIds = new Set<string>();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}] must be a JSON object`);
    }

    // Validate id
    const id = q.id;
    if (typeof id !== 'string' || !QUESTION_ID_REGEX.test(id)) {
      throw new ValidationError(
        `SURVEY_QUESTIONS[${i}].id must match pattern q<N> (e.g. 'q1', 'q2'), got '${id}'`,
      );
    }
    if (seenIds.has(id)) {
      throw new ValidationError(`Duplicate question id '${id}'`);
    }
    seenIds.add(id);

    // Validate type
    const type = q.type;
    if (!['single_choice', 'multiple_choice', 'open_text'].includes(type)) {
      throw new ValidationError(
        `SURVEY_QUESTIONS[${i}].type must be 'single_choice', 'multiple_choice', or 'open_text', got '${type}'`,
      );
    }

    // Validate text
    const text = q.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].text must be a non-empty string`);
    }
    if (text.length > MAX_QUESTION_TEXT_LENGTH) {
      throw new ValidationError(
        `SURVEY_QUESTIONS[${i}].text too long (${text.length} chars, max ${MAX_QUESTION_TEXT_LENGTH})`,
      );
    }

    // Validate options for choice types
    if (type === 'single_choice' || type === 'multiple_choice') {
      if (!Array.isArray(q.options) || q.options.length === 0) {
        throw new ValidationError(
          `SURVEY_QUESTIONS[${i}].options is required for '${type}' type and must be a non-empty array`,
        );
      }
      if (q.options.length > MAX_OPTIONS) {
        throw new ValidationError(
          `SURVEY_QUESTIONS[${i}].options too many (${q.options.length}, max ${MAX_OPTIONS})`,
        );
      }
      for (let j = 0; j < q.options.length; j++) {
        if (typeof q.options[j] !== 'string' || q.options[j].trim().length === 0) {
          throw new ValidationError(
            `SURVEY_QUESTIONS[${i}].options[${j}] must be a non-empty string`,
          );
        }
        if (q.options[j].length > MAX_OPTION_LENGTH) {
          throw new ValidationError(
            `SURVEY_QUESTIONS[${i}].options[${j}] too long (${q.options[j].length} chars, max ${MAX_OPTION_LENGTH})`,
          );
        }
      }
    }

    validated.push({
      id,
      type,
      text,
      ...(q.options ? { options: q.options } : {}),
    });
  }

  return validated;
}

export function validateUserId(userId: string): void {
  if (!userId) {
    throw new ValidationError('SURVEY_USER_ID environment variable is required');
  }
  if (!MEMBER_ID_REGEX.test(userId)) {
    throw new ValidationError(`Invalid user ID '${userId}' — expected ou_xxxxx format`);
  }
}

export function validateAnswer(
  questionId: string,
  answer: unknown,
  question: SurveyQuestion | undefined,
): void {
  if (!question) {
    throw new ValidationError(`Question '${questionId}' not found in survey`);
  }

  if (question.type === 'open_text') {
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      throw new ValidationError(`Answer for '${questionId}' must be a non-empty string`);
    }
    if (answer.length > MAX_OPEN_TEXT_LENGTH) {
      throw new ValidationError(
        `Answer for '${questionId}' too long (${answer.length} chars, max ${MAX_OPEN_TEXT_LENGTH})`,
      );
    }
  } else if (question.type === 'single_choice') {
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      throw new ValidationError(`Answer for '${questionId}' must be a non-empty string`);
    }
    if (question.options && !question.options.includes(answer)) {
      throw new ValidationError(
        `Answer '${answer}' is not a valid option for '${questionId}'. Valid options: ${question.options.join(', ')}`,
      );
    }
  } else if (question.type === 'multiple_choice') {
    if (!Array.isArray(answer) || answer.length === 0) {
      throw new ValidationError(`Answer for '${questionId}' must be a non-empty array`);
    }
    for (const a of answer) {
      if (typeof a !== 'string' || a.trim().length === 0) {
        throw new ValidationError(`Answer for '${questionId}' contains empty values`);
      }
      if (question.options && !question.options.includes(a)) {
        throw new ValidationError(
          `Answer '${a}' is not a valid option for '${questionId}'. Valid options: ${question.options.join(', ')}`,
        );
      }
    }
  }
}

export function validateAnswers(
  answers: unknown,
  questions: SurveyQuestion[],
): Record<string, string | string[]> {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new ValidationError('SURVEY_ANSWERS must be a JSON object mapping question IDs to answers');
  }

  const validated: Record<string, string | string[]> = {};
  const questionMap = new Map(questions.map(q => [q.id, q]));

  for (const [qId, answer] of Object.entries(answers as Record<string, unknown>)) {
    validateAnswer(qId, answer, questionMap.get(qId));
    validated[qId] = answer as string | string[];
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
  if (typeof obj.title !== 'string' || obj.title.trim().length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'title'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'expiresAt' (must be UTC Z-suffix)`);
  }
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'questions'`);
  }
  if (!Array.isArray(obj.targetUsers) || obj.targetUsers.length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'targetUsers'`);
  }
  if (typeof obj.anonymous !== 'boolean') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'anonymous' (must be boolean)`);
  }
  if (typeof obj.createdAt !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'createdAt'`);
  }

  return data as SurveyFile;
}

function isValidStatus(status: unknown): status is SurveyStatus {
  return typeof status === 'string' && ['active', 'closed', 'expired'].includes(status);
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}
