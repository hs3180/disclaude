/**
 * Survey schema definitions and validation functions.
 *
 * Issue #2191: Survey/Polling feature for collecting feedback from users.
 * Uses the same patterns as chat/schema.ts for consistency.
 */

// ---- Types ----

export type SurveyStatus = 'active' | 'closed';
export type QuestionType = 'single_choice';

export interface SurveyOption {
  text: string;
  value: string;
}

export interface SurveyQuestion {
  id: string;
  type: QuestionType;
  question: string;
  options: SurveyOption[];
}

export interface SurveyResponse {
  responder: string;
  answeredAt: string;
  answers: Record<string, string>; // questionId → option value
}

export interface SurveyFile {
  id: string;
  title: string;
  description: string;
  chatId: string;
  createdAt: string;
  expiresAt: string;
  anonymous: boolean;
  status: SurveyStatus;
  questions: SurveyQuestion[];
  responses: Record<string, SurveyResponse>; // responder → response
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;
export const OPEN_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const QUESTION_ID_REGEX = /^q\d+$/;
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_QUESTION_LENGTH = 200;
export const MAX_OPTION_TEXT_LENGTH = 50;
export const MAX_OPTION_VALUE_LENGTH = 50;
export const MAX_OPTIONS_PER_QUESTION = 10;
export const MAX_QUESTIONS = 20;

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
    throw new ValidationError(`Title too long (${title.length} chars, max ${MAX_TITLE_LENGTH})`);
  }
}

export function validateDescription(desc: string): void {
  // Description is optional; empty string is allowed
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Description too long (${desc.length} chars, max ${MAX_DESCRIPTION_LENGTH})`);
  }
}

export function validateChatId(chatId: string): void {
  if (!chatId) {
    throw new ValidationError('SURVEY_CHAT_ID environment variable is required');
  }
  if (!CHAT_ID_REGEX.test(chatId)) {
    throw new ValidationError(`Invalid chat ID '${chatId}' — must match oc_xxxxx format`);
  }
}

export function validateExpiresAt(expiresAt: string): void {
  if (!expiresAt) {
    throw new ValidationError('SURVEY_EXPIRES_AT environment variable is required');
  }
  if (!UTC_DATETIME_REGEX.test(expiresAt)) {
    throw new ValidationError(
      `SURVEY_EXPIRES_AT must be UTC Z-suffix format (e.g. 2026-04-19T10:00:00Z), got '${expiresAt}'`,
    );
  }
}

export function validateQuestions(questions: unknown): SurveyQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ValidationError('SURVEY_QUESTIONS must be a non-empty JSON array');
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new ValidationError(`Too many questions (${questions.length}, max ${MAX_QUESTIONS})`);
  }

  const seenIds = new Set<string>();
  const validated: SurveyQuestion[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}] must be an object`);
    }

    const obj = q as Record<string, unknown>;

    // Validate question id
    if (typeof obj.id !== 'string' || !QUESTION_ID_REGEX.test(obj.id)) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].id must match qN format (e.g. q1, q2)`);
    }
    if (seenIds.has(obj.id)) {
      throw new ValidationError(`Duplicate question id '${obj.id}'`);
    }
    seenIds.add(obj.id);

    // Validate question type
    if (obj.type !== 'single_choice') {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].type must be 'single_choice'`);
    }

    // Validate question text
    if (typeof obj.question !== 'string' || obj.question.trim().length === 0) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].question must be a non-empty string`);
    }
    if (obj.question.length > MAX_QUESTION_LENGTH) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].question too long (${obj.question.length} chars, max ${MAX_QUESTION_LENGTH})`);
    }

    // Validate options
    if (!Array.isArray(obj.options) || obj.options.length < 2) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].options must have at least 2 options`);
    }
    if (obj.options.length > MAX_OPTIONS_PER_QUESTION) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].options too many (${obj.options.length}, max ${MAX_OPTIONS_PER_QUESTION})`);
    }

    const seenValues = new Set<string>();
    const validatedOptions: SurveyOption[] = [];
    for (let j = 0; j < obj.options.length; j++) {
      const opt = obj.options[j];
      if (!opt || typeof opt !== 'object' || Array.isArray(opt)) {
        throw new ValidationError(`SURVEY_QUESTIONS[${i}].options[${j}] must be an object`);
      }
      const optObj = opt as Record<string, unknown>;
      if (typeof optObj.text !== 'string' || optObj.text.trim().length === 0) {
        throw new ValidationError(`SURVEY_QUESTIONS[${i}].options[${j}].text must be a non-empty string`);
      }
      if (optObj.text.length > MAX_OPTION_TEXT_LENGTH) {
        throw new ValidationError(`SURVEY_QUESTIONS[${i}].options[${j}].text too long (${optObj.text.length} chars, max ${MAX_OPTION_TEXT_LENGTH})`);
      }
      if (typeof optObj.value !== 'string' || optObj.value.trim().length === 0) {
        throw new ValidationError(`SURVEY_QUESTIONS[${i}].options[${j}].value must be a non-empty string`);
      }
      if (optObj.value.length > MAX_OPTION_VALUE_LENGTH) {
        throw new ValidationError(`SURVEY_QUESTIONS[${i}].options[${j}].value too long (${optObj.value.length} chars, max ${MAX_OPTION_VALUE_LENGTH})`);
      }
      if (seenValues.has(optObj.value)) {
        throw new ValidationError(`SURVEY_QUESTIONS[${i}].options[${j}].value '${optObj.value}' is duplicated`);
      }
      seenValues.add(optObj.value);
      validatedOptions.push({ text: optObj.text, value: optObj.value });
    }

    validated.push({
      id: obj.id,
      type: 'single_choice',
      question: obj.question,
      options: validatedOptions,
    });
  }

  return validated;
}

export function validateResponder(responder: string): void {
  if (!responder) {
    throw new ValidationError('SURVEY_RESPONDER environment variable is required');
  }
  if (!OPEN_ID_REGEX.test(responder)) {
    throw new ValidationError(`Invalid responder ID '${responder}' — expected ou_xxxxx format`);
  }
}

export function validateQuestionId(questionId: string): void {
  if (!questionId) {
    throw new ValidationError('SURVEY_QUESTION_ID environment variable is required');
  }
  if (!QUESTION_ID_REGEX.test(questionId)) {
    throw new ValidationError(`Invalid question ID '${questionId}' — must match qN format`);
  }
}

export function validateAnswer(answer: string): void {
  if (!answer) {
    throw new ValidationError('SURVEY_ANSWER environment variable is required');
  }
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Parse a survey file from JSON string */
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

  if (typeof obj.id !== 'string' || !SURVEY_ID_REGEX.test(obj.id)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'id'`);
  }
  if (typeof obj.title !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'title'`);
  }
  if (!isValidSurveyStatus(obj.status)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'status': '${obj.status}'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'expiresAt'`);
  }
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'questions'`);
  }

  return data as SurveyFile;
}

function isValidSurveyStatus(status: unknown): status is SurveyStatus {
  return typeof status === 'string' && ['active', 'closed'].includes(status);
}
