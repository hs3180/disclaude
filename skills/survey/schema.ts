/**
 * Survey schema definitions and validation functions.
 *
 * Data model for lightweight in-bot surveys with single-choice,
 * multiple-choice, and text question types.
 *
 * No external dependencies — uses only Node.js built-ins.
 */

// ---- Types ----

export type SurveyStatus = 'open' | 'closed';
export type QuestionType = 'single_choice' | 'multiple_choice' | 'text';

export interface SurveyQuestion {
  /** Unique question ID within the survey (e.g. "q1") */
  id: string;
  /** Question type */
  type: QuestionType;
  /** Question text */
  text: string;
  /** Options for choice-type questions */
  options?: string[];
  /** Whether the question is required */
  required?: boolean;
}

export interface SurveyResponse {
  /** ISO 8601 timestamp when response was submitted */
  answeredAt: string;
  /** Map of question ID to answer value */
  answers: Record<string, string | string[]>;
}

export interface SurveyFile {
  /** Unique survey identifier */
  id: string;
  /** Survey title */
  title: string;
  /** Survey description */
  description: string;
  /** Survey status: open or closed */
  status: SurveyStatus;
  /** Whether responses are anonymous */
  anonymous: boolean;
  /** ISO 8601 deadline (UTC Z-suffix) */
  deadline: string;
  /** Target user open IDs */
  targetUsers: string[];
  /** Survey questions */
  questions: SurveyQuestion[];
  /** User responses keyed by open ID (or anonymized key when anonymous) */
  responses: Record<string, SurveyResponse>;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** Creator's open ID */
  createdBy: string;
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const QUESTION_ID_REGEX = /^q\d+$/;
export const MAX_TITLE_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_QUESTIONS = 20;
export const MAX_OPTIONS = 10;
export const MAX_OPTION_LENGTH = 64;
export const MAX_TARGET_USERS = 100;
export const MAX_ANSWER_LENGTH = 2000;

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
    throw new ValidationError(`Title too long (${title.length} chars, max ${MAX_TITLE_LENGTH})`);
  }
}

export function validateDescription(desc: string): void {
  if (!desc) {
    throw new ValidationError('SURVEY_DESCRIPTION is required');
  }
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Description too long (${desc.length} chars, max ${MAX_DESCRIPTION_LENGTH})`);
  }
}

export function validateDeadline(deadline: string): void {
  if (!deadline) {
    throw new ValidationError('SURVEY_DEADLINE is required');
  }
  if (!UTC_DATETIME_REGEX.test(deadline)) {
    throw new ValidationError(
      `SURVEY_DEADLINE must be UTC Z-suffix format (e.g. 2026-04-30T10:00:00Z), got '${deadline}'`,
    );
  }
  const expiry = new Date(deadline);
  if (expiry <= new Date()) {
    console.error(`WARN: SURVEY_DEADLINE '${deadline}' is already in the past`);
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
  if (questions.length > MAX_QUESTIONS) {
    throw new ValidationError(`Too many questions (${questions.length}, max ${MAX_QUESTIONS})`);
  }

  const seenIds = new Set<string>();
  const validated: SurveyQuestion[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object') {
      throw new ValidationError(`questions[${i}] must be an object`);
    }

    const question = q as Record<string, unknown>;

    // Validate id
    if (typeof question.id !== 'string' || !QUESTION_ID_REGEX.test(question.id)) {
      throw new ValidationError(`questions[${i}].id must match pattern q0, q1, q2...`);
    }
    if (seenIds.has(question.id)) {
      throw new ValidationError(`Duplicate question id '${question.id}'`);
    }
    seenIds.add(question.id);

    // Validate type
    const validTypes: QuestionType[] = ['single_choice', 'multiple_choice', 'text'];
    if (!validTypes.includes(question.type as QuestionType)) {
      throw new ValidationError(`questions[${i}].type must be one of: ${validTypes.join(', ')}`);
    }

    // Validate text
    if (typeof question.text !== 'string' || question.text.trim().length === 0) {
      throw new ValidationError(`questions[${i}].text must be a non-empty string`);
    }

    // Validate options for choice types
    if (question.type === 'single_choice' || question.type === 'multiple_choice') {
      if (!Array.isArray(question.options) || question.options.length < 2) {
        throw new ValidationError(`questions[${i}].options must have at least 2 options for choice type`);
      }
      if (question.options.length > MAX_OPTIONS) {
        throw new ValidationError(`questions[${i}].options too many (${question.options.length}, max ${MAX_OPTIONS})`);
      }
      for (const opt of question.options) {
        if (typeof opt !== 'string' || opt.trim().length === 0) {
          throw new ValidationError(`questions[${i}].options contains empty or non-string value`);
        }
        if (opt.length > MAX_OPTION_LENGTH) {
          throw new ValidationError(`questions[${i}].options value too long (${opt.length}, max ${MAX_OPTION_LENGTH})`);
        }
      }
    }

    validated.push({
      id: question.id,
      type: question.type as QuestionType,
      text: question.text,
      options: question.options as string[] | undefined,
      required: question.required !== false, // default true
    });
  }

  return validated;
}

export function validateCreatedBy(createdBy: string): void {
  if (!createdBy) {
    throw new ValidationError('SURVEY_CREATED_BY is required');
  }
  if (!MEMBER_ID_REGEX.test(createdBy)) {
    throw new ValidationError(`Invalid creator ID '${createdBy}' — expected ou_xxxxx format`);
  }
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

  if (typeof obj.id !== 'string' || !SURVEY_ID_REGEX.test(obj.id)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'id'`);
  }
  if (!isValidStatus(obj.status)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'status': '${obj.status}'`);
  }
  if (typeof obj.title !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'title'`);
  }
  if (typeof obj.description !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'description'`);
  }
  if (typeof obj.deadline !== 'string' || !UTC_DATETIME_REGEX.test(obj.deadline)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'deadline'`);
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

function isValidStatus(status: unknown): status is SurveyStatus {
  return typeof status === 'string' && ['open', 'closed'].includes(status);
}

/** Validate an answer for a given question */
export function validateAnswer(question: SurveyQuestion, answer: unknown): string | string[] {
  if (question.type === 'text') {
    if (typeof answer !== 'string') {
      throw new ValidationError(`Answer for question '${question.id}' must be a string`);
    }
    if (answer.length > MAX_ANSWER_LENGTH) {
      throw new ValidationError(`Answer for question '${question.id}' too long (${answer.length}, max ${MAX_ANSWER_LENGTH})`);
    }
    return answer;
  }

  if (question.type === 'single_choice') {
    if (typeof answer !== 'string') {
      throw new ValidationError(`Answer for question '${question.id}' must be a string (single choice)`);
    }
    if (!question.options || !question.options.includes(answer)) {
      throw new ValidationError(`Answer '${answer}' is not a valid option for question '${question.id}'`);
    }
    return answer;
  }

  // multiple_choice
  if (!Array.isArray(answer)) {
    throw new ValidationError(`Answer for question '${question.id}' must be an array (multiple choice)`);
  }
  if (answer.length === 0) {
    throw new ValidationError(`Answer for question '${question.id}' must have at least one selection`);
  }
  for (const item of answer) {
    if (typeof item !== 'string') {
      throw new ValidationError(`Answer for question '${question.id}' contains non-string value`);
    }
    if (!question.options || !question.options.includes(item)) {
      throw new ValidationError(`Answer '${item}' is not a valid option for question '${question.id}'`);
    }
  }
  return answer;
}
