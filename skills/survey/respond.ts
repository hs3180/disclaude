#!/usr/bin/env tsx
/**
 * survey/respond.ts — Record a response to a survey.
 *
 * Environment variables:
 *   SURVEY_ID        (required) Survey identifier
 *   SURVEY_RESPONDER (required) Responder's open ID (ou_xxxxx)
 *   SURVEY_ANSWERS   (required) JSON object { "q1": "answer", "q2": ["a", "b"] }
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { readFile, writeFile, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  nowISO,
  SURVEY_DIR,
  ValidationError,
  MAX_ANSWER_TEXT_LENGTH,
  type SurveyFile,
  type SurveyResponse,
  type SurveyQuestion,
} from './schema.js';
import { withExclusiveLock } from '../chat/lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateResponder(responder: string): void {
  if (!responder) {
    throw new ValidationError('SURVEY_RESPONDER is required');
  }
  if (!/^ou_[a-zA-Z0-9]+$/.test(responder)) {
    throw new ValidationError(`Invalid responder ID '${responder}' — expected ou_xxxxx format`);
  }
}

function validateAnswers(
  answers: unknown,
  questions: SurveyQuestion[],
): Record<string, string | string[]> {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new ValidationError('SURVEY_ANSWERS must be a JSON object');
  }

  const validated: Record<string, string | string[]> = {};
  const answersObj = answers as Record<string, unknown>;

  // Check that all question IDs are present and answers are valid
  for (const question of questions) {
    const answer = answersObj[question.id];
    if (answer === undefined || answer === null) {
      continue; // Allow partial responses (user may skip questions)
    }

    if (question.type === 'single_choice') {
      if (typeof answer !== 'string') {
        throw new ValidationError(`Answer for '${question.id}' must be a string (single choice)`);
      }
      if (question.options && !question.options.includes(answer)) {
        throw new ValidationError(
          `Answer '${answer}' for '${question.id}' is not a valid option`,
        );
      }
      validated[question.id] = answer;
    } else if (question.type === 'multiple_choice') {
      if (!Array.isArray(answer)) {
        throw new ValidationError(`Answer for '${question.id}' must be an array (multiple choice)`);
      }
      const maxSel = question.maxSelections ?? answer.length;
      if (answer.length > maxSel) {
        throw new ValidationError(
          `Answer for '${question.id}' has too many selections (${answer.length}, max ${maxSel})`,
        );
      }
      for (const item of answer) {
        if (typeof item !== 'string') {
          throw new ValidationError(`Answer items for '${question.id}' must be strings`);
        }
        if (question.options && !question.options.includes(item)) {
          throw new ValidationError(
            `Answer '${item}' for '${question.id}' is not a valid option`,
          );
        }
      }
      validated[question.id] = answer;
    } else if (question.type === 'text') {
      if (typeof answer !== 'string') {
        throw new ValidationError(`Answer for '${question.id}' must be a string`);
      }
      if (answer.length > MAX_ANSWER_TEXT_LENGTH) {
        throw new ValidationError(
          `Answer for '${question.id}' too long (${answer.length}, max ${MAX_ANSWER_TEXT_LENGTH})`,
        );
      }
      validated[question.id] = answer;
    }
  }

  // Check for unknown question IDs
  const questionIds = new Set(questions.map((q) => q.id));
  for (const key of Object.keys(answersObj)) {
    if (!questionIds.has(key)) {
      throw new ValidationError(`Unknown question ID '${key}'`);
    }
  }

  return validated;
}

async function main() {
  // ---- Step 1: Validate survey ID ----
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Validate responder ----
  const responder = process.env.SURVEY_RESPONDER;
  try {
    validateResponder(responder ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 3: Parse answers ----
  const answersRaw = process.env.SURVEY_ANSWERS;
  let answersParsed: unknown;
  try {
    answersParsed = answersRaw ? JSON.parse(answersRaw) : undefined;
  } catch {
    exit(`SURVEY_ANSWERS must be valid JSON: ${answersRaw}`);
  }

  // ---- Step 4: Read and validate survey file ----
  const surveyDir = resolve(SURVEY_DIR);
  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  let existingData: string;
  try {
    existingData = await readFile(surveyFile, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey ${surveyId} not found`);
    }
    exit(`Failed to read survey file: ${err}`);
  }

  let survey: SurveyFile;
  try {
    survey = parseSurveyFile(existingData, surveyFile);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 5: Validate survey state ----
  if (survey.status === 'closed') {
    exit(`Survey ${surveyId} is already closed`);
  }

  // Check expiry
  if (new Date(survey.expiresAt) <= new Date()) {
    exit(`Survey ${surveyId} has expired`);
  }

  // Check if user is a target
  if (!survey.targetUsers.includes(responder!)) {
    exit(`User ${responder} is not a target of survey ${surveyId}`);
  }

  // ---- Step 6: Validate answers against questions ----
  let answers: Record<string, string | string[]>;
  try {
    answers = validateAnswers(answersParsed, survey.questions);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 7: Check for duplicate response (update if exists) ----
  const existingResponseIndex = survey.responses.findIndex(
    (r) => r.responder === responder,
  );

  const newResponse: SurveyResponse = {
    responder: responder!,
    respondedAt: nowISO(),
    answers,
  };

  if (existingResponseIndex >= 0) {
    // Update existing response
    survey.responses[existingResponseIndex] = newResponse;
  } else {
    survey.responses.push(newResponse);
  }

  // ---- Step 8: Write updated survey file under lock ----
  const lockPath = `${surveyFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Re-read to ensure no concurrent modification
    let currentData: string;
    try {
      currentData = await readFile(surveyFile, 'utf-8');
    } catch {
      throw new Error(`Failed to re-read survey file before write`);
    }

    // Merge our response into the current data
    const currentSurvey = parseSurveyFile(currentData, surveyFile);

    // Re-check state
    if (currentSurvey.status === 'closed') {
      throw new ValidationError(`Survey ${surveyId} was closed by another process`);
    }

    const existingIdx = currentSurvey.responses.findIndex(
      (r) => r.responder === responder,
    );

    if (existingIdx >= 0) {
      currentSurvey.responses[existingIdx] = newResponse;
    } else {
      currentSurvey.responses.push(newResponse);
    }

    // Atomic write
    const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(currentSurvey, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, surveyFile);
  });

  const action = existingResponseIndex >= 0 ? 'updated' : 'recorded';
  console.log(`OK: Response ${action} for ${responder} in survey ${surveyId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
