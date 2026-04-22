/**
 * Survey schema definitions and validation functions.
 *
 * Survey data model for lightweight in-bot polling.
 * Phase 1 (#2191): Single-choice questions only, card-based interaction.
 *
 * No external dependencies — uses only Node.js built-ins.
 */

// ---- Types ----

export type SurveyStatus = 'open' | 'closed' | 'expired';

export type QuestionType = 'single_choice' | 'multiple_choice' | 'text';

export interface SurveyQuestion {
  /** Question text displayed to user */
  text: string;
  /** Question type */
  type: QuestionType;
  /** Available options (required for single_choice / multiple_choice) */
  options: string[];
  /** Whether the question is required */
  required: boolean;
}

export interface SurveyResponse {
  /** Responder's open ID (or 'anonymous' if anonymous) */
  responder: string;
  /** Timestamp of response */
  respondedAt: string;
  /** Answers keyed by question index: { "0": "Option A", "1": "Good" } */
  answers: Record<string, string | string[]>;
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
  /** Questions array */
  questions: SurveyQuestion[];
  /** Target participant open IDs */
  participants: string[];
  /** Whether responses are anonymous */
  anonymous: boolean;
  /** ISO 8601 Z-suffix creation timestamp */
  createdAt: string;
  /** ISO 8601 Z-suffix deadline (required) */
  deadline: string;
  /** ISO 8601 Z-suffix closed timestamp (set when manually closed or expired) */
  closedAt: string | null;
  /** Collected responses */
  responses: SurveyResponse[];
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_QUESTIONS = 10;
export const MAX_OPTIONS = 8;
export const MAX_OPTION_LENGTH = 50;
export const MAX_QUESTION_TEXT_LENGTH = 200;
export const MAX_PARTICIPANTS = 50;
export const MAX_RESPONSES = 500;
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
    throw new ValidationError('SURVEY_TITLE is required');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`SURVEY_TITLE too long (${title.length} chars, max ${MAX_TITLE_LENGTH})`);
  }
}

export function validateDescription(desc: string): void {
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`SURVEY_DESCRIPTION too long (${desc.length} chars, max ${MAX_DESCRIPTION_LENGTH})`);
  }
}

export function validateDeadline(deadline: string): void {
  if (!deadline) {
    throw new ValidationError('SURVEY_DEADLINE is required');
  }
  if (!UTC_DATETIME_REGEX.test(deadline)) {
    throw new ValidationError(
      `SURVEY_DEADLINE must be UTC Z-suffix format (e.g. 2026-03-25T10:00:00Z), got '${deadline}'`,
    );
  }
}

export function validateParticipants(participants: unknown): string[] {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new ValidationError('SURVEY_PARTICIPANTS must be a non-empty JSON array of open IDs');
  }
  if (participants.length > MAX_PARTICIPANTS) {
    throw new ValidationError(`Too many participants (${participants.length}, max ${MAX_PARTICIPANTS})`);
  }
  for (const p of participants) {
    if (typeof p !== 'string' || !MEMBER_ID_REGEX.test(p)) {
      throw new ValidationError(`Invalid participant ID '${p}' — expected ou_xxxxx format`);
    }
  }
  return participants;
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
      throw new ValidationError(`questions[${i}] must be an object`);
    }

    const text = (q as Record<string, unknown>).text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ValidationError(`questions[${i}].text is required`);
    }
    if (text.length > MAX_QUESTION_TEXT_LENGTH) {
      throw new ValidationError(`questions[${i}].text too long (${text.length} chars, max ${MAX_QUESTION_TEXT_LENGTH})`);
    }

    const type = (q as Record<string, unknown>).type;
    if (!['single_choice', 'multiple_choice', 'text'].includes(type as string)) {
      throw new ValidationError(`questions[${i}].type must be 'single_choice', 'multiple_choice', or 'text'`);
    }

    const options = (q as Record<string, unknown>).options;
    if (type !== 'text') {
      if (!Array.isArray(options) || options.length === 0) {
        throw new ValidationError(`questions[${i}].options is required for choice questions`);
      }
      if (options.length > MAX_OPTIONS) {
        throw new ValidationError(`questions[${i}] has too many options (${options.length}, max ${MAX_OPTIONS})`);
      }
      for (const opt of options) {
        if (typeof opt !== 'string' || opt.trim().length === 0) {
          throw new ValidationError(`questions[${i}].options must be non-empty strings`);
        }
        if (opt.length > MAX_OPTION_LENGTH) {
          throw new ValidationError(`questions[${i}].option '${opt}' too long (max ${MAX_OPTION_LENGTH})`);
        }
      }
    }

    const required = (q as Record<string, unknown>).required;
    validated.push({
      text: text.trim(),
      type: type as QuestionType,
      options: Array.isArray(options) ? options.map((o: unknown) => String(o).trim()) : [],
      required: typeof required === 'boolean' ? required : true,
    });
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

  if (typeof obj.id !== 'string' || !SURVEY_ID_REGEX.test(obj.id)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'id'`);
  }

  if (!isValidStatus(obj.status)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'status': '${obj.status}'`);
  }

  if (typeof obj.title !== 'string' || obj.title.trim().length === 0) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'title'`);
  }

  if (typeof obj.deadline !== 'string' || !UTC_DATETIME_REGEX.test(obj.deadline)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'deadline'`);
  }

  if (!Array.isArray(obj.questions)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'questions'`);
  }

  if (!Array.isArray(obj.participants)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'participants'`);
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
