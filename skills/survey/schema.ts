/**
 * Survey schema definitions and validation functions.
 *
 * Follows the same pattern as skills/chat/schema.ts.
 * No external dependencies — uses only Node.js built-ins.
 */

// ---- Types ----

export type SurveyStatus = 'open' | 'closed' | 'expired';

export type QuestionType = 'single_choice';

export interface SurveyQuestion {
  /** Question index (0-based) */
  index: number;
  /** Question text */
  text: string;
  /** Question type */
  type: QuestionType;
  /** Available options */
  options: string[];
}

export interface SurveyResponse {
  /** Responder's open ID */
  responder: string;
  /** Question index */
  questionIndex: number;
  /** Selected option index */
  optionIndex: number;
  /** Response timestamp (ISO 8601 Z-suffix) */
  respondedAt: string;
}

export interface SurveyFile {
  /** Unique survey identifier */
  id: string;
  /** Survey status */
  status: SurveyStatus;
  /** Survey title */
  title: string;
  /** Survey description */
  description: string;
  /** Whether responses are anonymous */
  anonymous: boolean;
  /** Target user open IDs */
  targets: string[];
  /** Survey questions */
  questions: SurveyQuestion[];
  /** Deadline (ISO 8601 Z-suffix) */
  deadline: string;
  /** Creation timestamp */
  createdAt: string;
  /** Chat ID where survey was sent */
  chatId: string | null;
  /** Responses keyed by `responder:questionIndex` */
  responses: Record<string, SurveyResponse>;
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const MAX_TITLE_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_QUESTION_TEXT_LENGTH = 512;
export const MAX_OPTION_TEXT_LENGTH = 64;
export const MAX_QUESTIONS = 10;
export const MAX_OPTIONS_PER_QUESTION = 6;
export const MAX_TARGETS = 50;

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
    throw new ValidationError('SURVEY_TITLE is required');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`SURVEY_TITLE too long (${title.length}, max ${MAX_TITLE_LENGTH})`);
  }
}

export function validateDescription(desc: string): void {
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`SURVEY_DESCRIPTION too long (${desc.length}, max ${MAX_DESCRIPTION_LENGTH})`);
  }
}

export function validateTargets(targets: unknown): string[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new ValidationError('SURVEY_TARGETS must be a non-empty JSON array of open IDs');
  }
  if (targets.length > MAX_TARGETS) {
    throw new ValidationError(`Too many targets (${targets.length}, max ${MAX_TARGETS})`);
  }
  for (const t of targets) {
    if (typeof t !== 'string' || !MEMBER_ID_REGEX.test(t)) {
      throw new ValidationError(`Invalid target ID '${t}' — expected ou_xxxxx format`);
    }
  }
  return targets;
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
}

export function validateQuestions(questions: unknown): SurveyQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ValidationError('SURVEY_QUESTIONS must be a non-empty JSON array');
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new ValidationError(`Too many questions (${questions.length}, max ${MAX_QUESTIONS})`);
  }

  const validated: SurveyQuestion[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object') {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}] must be an object`);
    }
    const obj = q as Record<string, unknown>;
    if (typeof obj.text !== 'string' || obj.text.trim().length === 0) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].text is required`);
    }
    if (obj.text.length > MAX_QUESTION_TEXT_LENGTH) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].text too long (${obj.text.length}, max ${MAX_QUESTION_TEXT_LENGTH})`);
    }
    if (!Array.isArray(obj.options) || obj.options.length < 2) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].options must be an array with at least 2 options`);
    }
    if (obj.options.length > MAX_OPTIONS_PER_QUESTION) {
      throw new ValidationError(`SURVEY_QUESTIONS[${i}].options too many (${obj.options.length}, max ${MAX_OPTIONS_PER_QUESTION})`);
    }
    for (let j = 0; j < obj.options.length; j++) {
      if (typeof obj.options[j] !== 'string' || obj.options[j].trim().length === 0) {
        throw new ValidationError(`SURVEY_QUESTIONS[${i}].options[${j}] must be a non-empty string`);
      }
      if (obj.options[j].length > MAX_OPTION_TEXT_LENGTH) {
        throw new ValidationError(`SURVEY_QUESTIONS[${i}].options[${j}] too long (${obj.options[j].length}, max ${MAX_OPTION_TEXT_LENGTH})`);
      }
    }
    validated.push({
      index: i,
      text: obj.text,
      type: 'single_choice',
      options: obj.options,
    });
  }
  return validated;
}

export function validateResponder(responder: string): void {
  if (!responder) {
    throw new ValidationError('RESPONDER is required');
  }
  if (!MEMBER_ID_REGEX.test(responder)) {
    throw new ValidationError(`Invalid responder ID '${responder}' — expected ou_xxxxx format`);
  }
}

export function validateQuestionIndex(index: unknown, maxIndex: number): number {
  const num = Number(index);
  if (!Number.isInteger(num) || num < 0 || num >= maxIndex) {
    throw new ValidationError(`QUESTION_INDEX must be an integer in [0, ${maxIndex - 1}], got '${index}'`);
  }
  return num;
}

export function validateOptionIndex(index: unknown, maxIndex: number): number {
  const num = Number(index);
  if (!Number.isInteger(num) || num < 0 || num >= maxIndex) {
    throw new ValidationError(`OPTION_INDEX must be an integer in [0, ${maxIndex - 1}], got '${index}'`);
  }
  return num;
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
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'title'`);
  }
  if (typeof obj.deadline !== 'string' || !UTC_DATETIME_REGEX.test(obj.deadline)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'deadline'`);
  }
  if (!Array.isArray(obj.questions)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'questions'`);
  }
  if (!Array.isArray(obj.targets)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'targets'`);
  }
  if (typeof obj.anonymous !== 'boolean') {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'anonymous'`);
  }

  return data as SurveyFile;
}

function isValidStatus(status: unknown): status is SurveyStatus {
  return typeof status === 'string' && ['open', 'closed', 'expired'].includes(status);
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Check if a survey deadline has passed */
export function isExpired(deadline: string): boolean {
  return new Date(deadline) <= new Date();
}

/** Build the response key for deduplication */
export function responseKey(responder: string, questionIndex: number): string {
  return `${responder}:${questionIndex}`;
}
