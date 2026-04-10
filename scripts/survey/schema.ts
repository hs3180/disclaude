/**
 * Survey schema definitions and validation functions.
 *
 * No external dependencies — uses only Node.js built-ins.
 */

// ---- Types ----

export type SurveyStatus = 'active' | 'closed';
export type QuestionType = 'single_choice' | 'text';

export interface SurveyQuestion {
  id: string;
  type: QuestionType;
  question: string;
  options?: string[];
}

export interface SurveyResponse {
  completedAt?: string;
  [questionId: string]: string | undefined;
}

export interface SurveyFile {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  createdBy: string;
  deadline: string;
  anonymous: boolean;
  targetUsers: string[];
  questions: SurveyQuestion[];
  responses: Record<string, SurveyResponse>;
  status: SurveyStatus;
}

// ---- Constants ----

export const SURVEY_DIR = 'workspace/surveys';
export const SURVEY_ID_PREFIX = 'survey';
export const QUESTION_ID_REGEX = /^q\d+$/;
export const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const MAX_TITLE_LENGTH = 128;
export const MAX_QUESTION_LENGTH = 500;
export const MAX_OPTION_LENGTH = 64;
export const MAX_OPTIONS_COUNT = 10;
export const MIN_OPTIONS_COUNT = 2;
export const MAX_QUESTIONS_COUNT = 20;
export const MAX_RESPONSE_LENGTH = 2000;
export const MAX_TARGETS_COUNT = 100;

// ---- Validation helpers ----

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
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

export function validateQuestions(questions: unknown): SurveyQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ValidationError('SURVEY_QUESTIONS must be a non-empty JSON array');
  }
  if (questions.length > MAX_QUESTIONS_COUNT) {
    throw new ValidationError(`Too many questions (${questions.length}, max ${MAX_QUESTIONS_COUNT})`);
  }

  const validated: SurveyQuestion[] = [];
  const usedIds = new Set<string>();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      throw new ValidationError(`Question ${i + 1} must be a JSON object`);
    }

    // Validate id
    const id = (q as Record<string, unknown>).id;
    if (typeof id !== 'string' || !QUESTION_ID_REGEX.test(id)) {
      throw new ValidationError(`Question ${i + 1} has invalid 'id' (expected format: q1, q2, ...)`);
    }
    if (usedIds.has(id)) {
      throw new ValidationError(`Duplicate question id '${id}'`);
    }
    usedIds.add(id);

    // Validate type
    const type = (q as Record<string, unknown>).type;
    if (type !== 'single_choice' && type !== 'text') {
      throw new ValidationError(`Question ${i + 1} has invalid type '${type}' (expected 'single_choice' or 'text')`);
    }

    // Validate question text
    const question = (q as Record<string, unknown>).question;
    if (typeof question !== 'string' || question.trim().length === 0) {
      throw new ValidationError(`Question ${i + 1} must have non-empty 'question' text`);
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      throw new ValidationError(`Question ${i + 1} too long (${question.length} chars, max ${MAX_QUESTION_LENGTH})`);
    }

    const validatedQ: SurveyQuestion = { id, type, question };

    // Validate options for single_choice
    if (type === 'single_choice') {
      const options = (q as Record<string, unknown>).options;
      if (!Array.isArray(options) || options.length < MIN_OPTIONS_COUNT) {
        throw new ValidationError(`Question ${i + 1} (single_choice) must have at least ${MIN_OPTIONS_COUNT} options`);
      }
      if (options.length > MAX_OPTIONS_COUNT) {
        throw new ValidationError(`Question ${i + 1} has too many options (${options.length}, max ${MAX_OPTIONS_COUNT})`);
      }
      for (const opt of options) {
        if (typeof opt !== 'string' || opt.trim().length === 0) {
          throw new ValidationError(`Question ${i + 1} has invalid option: '${opt}'`);
        }
        if (opt.length > MAX_OPTION_LENGTH) {
          throw new ValidationError(`Question ${i + 1} option too long: '${opt.substring(0, 20)}...'`);
        }
      }
      validatedQ.options = options;
    }

    validated.push(validatedQ);
  }

  return validated;
}

export function validateDeadline(deadline: string): void {
  if (!deadline) {
    throw new ValidationError('SURVEY_DEADLINE is required');
  }
  if (!UTC_DATETIME_REGEX.test(deadline)) {
    throw new ValidationError(
      `SURVEY_DEADLINE must be UTC Z-suffix format (e.g. 2026-04-15T18:00:00Z), got '${deadline}'`,
    );
  }
}

export function validateTargets(targets: unknown): string[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new ValidationError('SURVEY_TARGETS must be a non-empty JSON array of open IDs');
  }
  if (targets.length > MAX_TARGETS_COUNT) {
    throw new ValidationError(`Too many targets (${targets.length}, max ${MAX_TARGETS_COUNT})`);
  }
  for (const t of targets) {
    if (typeof t !== 'string' || !MEMBER_ID_REGEX.test(t)) {
      throw new ValidationError(`Invalid target ID '${t}' — expected ou_xxxxx format`);
    }
  }
  return targets;
}

export function validateCreator(creator: string): void {
  if (!creator) {
    throw new ValidationError('SURVEY_CREATOR is required');
  }
  if (!MEMBER_ID_REGEX.test(creator)) {
    throw new ValidationError(`Invalid creator ID '${creator}' — expected ou_xxxxx format`);
  }
}

export function validateResponder(responder: string): void {
  if (!responder) {
    throw new ValidationError('SURVEY_RESPONDER is required');
  }
  if (!MEMBER_ID_REGEX.test(responder)) {
    throw new ValidationError(`Invalid responder ID '${responder}' — expected ou_xxxxx format`);
  }
}

export function validateSurveyId(id: string): void {
  if (!id) {
    throw new ValidationError('SURVEY_ID is required');
  }
}

export function validateQuestionId(questionId: string): void {
  if (!questionId) {
    throw new ValidationError('SURVEY_QUESTION_ID is required');
  }
  if (!QUESTION_ID_REGEX.test(questionId)) {
    throw new ValidationError(`Invalid question ID '${questionId}' (expected format: q1, q2, ...)`);
  }
}

export function validateAnswer(answer: string): void {
  if (!answer) {
    throw new ValidationError('SURVEY_ANSWER is required');
  }
  if (answer.length > MAX_RESPONSE_LENGTH) {
    throw new ValidationError(`Answer too long (${answer.length} chars, max ${MAX_RESPONSE_LENGTH})`);
  }
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Generate a unique survey ID */
export function generateSurveyId(): string {
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 8);
  return `${SURVEY_ID_PREFIX}-${date}-${rand}`;
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

  if (typeof obj.id !== 'string' || !obj.id.startsWith(SURVEY_ID_PREFIX)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid or missing 'id'`);
  }
  if (typeof obj.title !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has missing 'title'`);
  }
  if (!['active', 'closed'].includes(obj.status as string)) {
    throw new ValidationError(`Survey file '${filePath}' has invalid 'status': '${obj.status}'`);
  }
  if (!Array.isArray(obj.questions)) {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'questions'`);
  }
  if (typeof obj.deadline !== 'string') {
    throw new ValidationError(`Survey file '${filePath}' has missing 'deadline'`);
  }
  if (typeof obj.anonymous !== 'boolean') {
    throw new ValidationError(`Survey file '${filePath}' has missing or invalid 'anonymous'`);
  }

  return data as SurveyFile;
}
