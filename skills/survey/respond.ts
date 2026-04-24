#!/usr/bin/env tsx
/**
 * survey/respond.ts — Record a response to a survey.
 *
 * Environment variables:
 *   SURVEY_ID           (required) Survey identifier
 *   SURVEY_RESPONDENT   (required) Respondent's open ID
 *   SURVEY_ANSWERS      (required) JSON object of question ID -> answer value
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  validateAnswer,
  nowISO,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
} from './schema.js';
import { withExclusiveLock } from './lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Step 1: Validate inputs ----
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const respondent = process.env.SURVEY_RESPONDENT;
  if (!respondent) {
    exit('SURVEY_RESPONDENT is required');
  }

  const answersRaw = process.env.SURVEY_ANSWERS;
  let answers: Record<string, unknown>;
  try {
    answers = answersRaw ? JSON.parse(answersRaw) : {};
    if (typeof answers !== 'object' || Array.isArray(answers)) {
      throw new Error('must be a JSON object');
    }
  } catch {
    exit(`SURVEY_ANSWERS must be valid JSON object: ${answersRaw}`);
  }

  // ---- Step 2: Read and validate survey file ----
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
    throw err;
  }

  const survey: SurveyFile = parseSurveyFile(existingData, surveyFile);

  // ---- Step 3: Business logic checks ----
  if (survey.status !== 'open') {
    exit(`Survey ${surveyId} is ${survey.status}, cannot accept responses`);
  }

  // Check deadline
  if (new Date(survey.deadline) <= new Date()) {
    exit(`Survey ${surveyId} deadline has passed (${survey.deadline})`);
  }

  // Check if respondent is a target user
  if (!survey.targetUsers.includes(respondent)) {
    exit(`User ${respondent} is not a target user for survey ${surveyId}`);
  }

  // Check for duplicate response
  if (survey.responses[respondent]) {
    exit(`User ${respondent} has already responded to survey ${surveyId}`);
  }

  // ---- Step 4: Validate answers against questions ----
  const validatedAnswers: Record<string, string | string[]> = {};
  for (const question of survey.questions) {
    const answer = answers[question.id];
    if (answer === undefined || answer === null || answer === '') {
      if (question.required !== false) {
        exit(`Required question '${question.id}' is missing`);
      }
      continue;
    }
    try {
      validatedAnswers[question.id] = validateAnswer(question, answer);
    } catch (err) {
      exit(err instanceof ValidationError ? err.message : String(err));
    }
  }

  // Check for unexpected answers (answers for non-existent questions)
  for (const qId of Object.keys(answers)) {
    if (!survey.questions.some((q) => q.id === qId)) {
      exit(`Unknown question ID '${qId}' in answers`);
    }
  }

  // ---- Step 5: Write response under lock ----
  const lockPath = `${surveyFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Re-read under lock to check for concurrent modification
    let currentData: string;
    try {
      currentData = await readFile(surveyFile, 'utf-8');
    } catch {
      exit(`Survey file disappeared during operation`);
    }
    const currentSurvey = parseSurveyFile(currentData, surveyFile);

    if (currentSurvey.responses[respondent]) {
      exit(`User ${respondent} has already responded (concurrent write detected)`);
    }

    currentSurvey.responses[respondent] = {
      answeredAt: nowISO(),
      answers: validatedAnswers,
    };

    // Atomic write
    const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(currentSurvey, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, surveyFile);
  });

  console.log(`OK: Response recorded for ${respondent} on survey ${surveyId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
