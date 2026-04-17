#!/usr/bin/env tsx
/**
 * survey/respond.ts — Record a user response to a survey.
 *
 * Environment variables:
 *   SURVEY_ID        (required) Survey identifier
 *   SURVEY_USER      (required) User open ID (ou_xxxxx)
 *   SURVEY_ANSWERS   (required) JSON object of question ID → answer
 *                       For single_choice: string
 *                       For multiple_choice: string[] (JSON array)
 *                       For text: string
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 *
 * @module skills/survey/respond
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  nowISO,
  SURVEY_DIR,
  MEMBER_ID_REGEX,
  MAX_ANSWER_LENGTH,
  ValidationError,
  type SurveyFile,
} from './schema.js';
import { withExclusiveLock } from '../chat/lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Validate answer against question type.
 */
function validateAnswer(
  questionId: string,
  answer: unknown,
  survey: SurveyFile,
): string | string[] {
  const question = survey.questions.find((q) => q.id === questionId);
  if (!question) {
    throw new ValidationError(`Question '${questionId}' not found in survey`);
  }

  if (question.type === 'text') {
    if (typeof answer !== 'string') {
      throw new ValidationError(`Answer for '${questionId}' must be a string (text question)`);
    }
    if (answer.length > MAX_ANSWER_LENGTH) {
      throw new ValidationError(
        `Answer for '${questionId}' too long (${answer.length} chars, max ${MAX_ANSWER_LENGTH})`,
      );
    }
    return answer;
  }

  if (question.type === 'single_choice') {
    if (typeof answer !== 'string') {
      throw new ValidationError(`Answer for '${questionId}' must be a string (single choice)`);
    }
    if (!question.options?.includes(answer)) {
      throw new ValidationError(
        `Answer '${answer}' is not a valid option for '${questionId}'. Valid: ${question.options?.join(', ')}`,
      );
    }
    return answer;
  }

  if (question.type === 'multiple_choice') {
    if (!Array.isArray(answer)) {
      throw new ValidationError(`Answer for '${questionId}' must be an array (multiple choice)`);
    }
    for (const item of answer) {
      if (typeof item !== 'string') {
        throw new ValidationError(`Answer items for '${questionId}' must be strings`);
      }
      if (!question.options?.includes(item)) {
        throw new ValidationError(
          `Answer '${item}' is not a valid option for '${questionId}'`,
        );
      }
    }
    return answer as string[];
  }

  throw new ValidationError(`Unknown question type '${question.type}' for '${questionId}'`);
}

async function main() {
  // ---- Step 1: Validate inputs ----
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const user = process.env.SURVEY_USER;
  if (!user || !MEMBER_ID_REGEX.test(user)) {
    exit(`Invalid user ID '${user}' — expected ou_xxxxx format`);
  }

  const answersRaw = process.env.SURVEY_ANSWERS;
  let answersInput: Record<string, unknown>;
  try {
    answersInput = answersRaw ? JSON.parse(answersRaw) : {};
  } catch {
    exit(`SURVEY_ANSWERS must be valid JSON: ${answersRaw}`);
  }

  // ---- Step 2: Read and validate survey file ----
  const surveyFile = resolve(SURVEY_DIR, `${surveyId}.json`);

  let existingJson: string;
  try {
    existingJson = await readFile(surveyFile, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey ${surveyId} not found`);
    }
    exit(`Failed to read survey file: ${err}`);
  }

  const survey = parseSurveyFile(existingJson, surveyFile);

  // ---- Step 3: Check survey status ----
  if (survey.status === 'closed') {
    exit(`Survey ${surveyId} is closed (closed at ${survey.closedAt})`);
  }

  // Check deadline
  if (survey.deadline && new Date(survey.deadline) <= new Date()) {
    exit(`Survey ${surveyId} deadline has passed (${survey.deadline})`);
  }

  // ---- Step 4: Validate answers ----
  const validatedAnswers: Record<string, string | string[]> = {};

  for (const question of survey.questions) {
    const answer = answersInput[question.id];

    // Check required questions
    if (answer === undefined || answer === null) {
      if (question.required) {
        exit(`Required question '${question.id}' is not answered`);
      }
      continue;
    }

    try {
      validatedAnswers[question.id] = validateAnswer(question.id, answer, survey);
    } catch (err) {
      exit(err instanceof ValidationError ? err.message : String(err));
    }
  }

  // ---- Step 5: Record response under lock ----
  const lockPath = `${surveyFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Re-read the file under lock to avoid TOCTOU
    let lockedJson: string;
    try {
      lockedJson = await readFile(surveyFile, 'utf-8');
    } catch (err: unknown) {
      const nodeErr = err as { code?: string };
      if (nodeErr.code === 'ENOENT') {
        throw new ValidationError(`Survey ${surveyId} not found`);
      }
      throw new Error(`Failed to read survey file: ${err}`);
    }

    const lockedSurvey = parseSurveyFile(lockedJson, surveyFile);

    if (lockedSurvey.status === 'closed') {
      throw new ValidationError(`Survey ${surveyId} is closed`);
    }

    // Use anonymized key if survey is anonymous
    const responseKey = survey.anonymous
      ? `anon_${Object.keys(lockedSurvey.responses).length + 1}`
      : user;

    // Check for duplicate response (non-anonymous only)
    if (!survey.anonymous && lockedSurvey.responses[responseKey]) {
      throw new ValidationError(`User ${user} has already responded to survey ${surveyId}`);
    }

    // Update responses
    lockedSurvey.responses[responseKey] = {
      respondedAt: nowISO(),
      answers: validatedAnswers,
    };

    // Atomic write
    const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(lockedSurvey, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, surveyFile);
  });

  console.log(`OK: Response recorded for survey ${surveyId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
