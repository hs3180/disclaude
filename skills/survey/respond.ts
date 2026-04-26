#!/usr/bin/env tsx
/**
 * survey/respond.ts — Record a user's response to a survey.
 *
 * Environment variables:
 *   SURVEY_ID        (required) Survey identifier
 *   SURVEY_RESPONDER (required) Responder's open ID
 *   SURVEY_ANSWERS   (required) JSON object mapping question IDs to answers
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  validateAnswer,
  nowISO,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
  type SurveyResponse,
} from './schema.js';
import { withExclusiveLock } from '../chat/lock.js';

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

  const responder = process.env.SURVEY_RESPONDER;
  if (!responder || typeof responder !== 'string') {
    exit('SURVEY_RESPONDER is required');
  }

  const answersRaw = process.env.SURVEY_ANSWERS;
  let answers: Record<string, unknown>;
  try {
    answers = answersRaw ? JSON.parse(answersRaw) : {};
  } catch {
    exit(`SURVEY_ANSWERS must be valid JSON: ${answersRaw}`);
  }

  // ---- Step 2: Read and validate survey file ----
  const surveyDir = resolve(SURVEY_DIR);
  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  let survey: SurveyFile;
  try {
    const content = await readFile(surveyFile, 'utf-8');
    survey = parseSurveyFile(content, surveyFile);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`Survey '${surveyId}' not found`);
  }

  // ---- Step 3: Check survey status ----
  if (survey.status !== 'active') {
    exit(`Survey '${surveyId}' is not active (status: ${survey.status})`);
  }

  // ---- Step 4: Check if responder is a target user ----
  if (!survey.targetUsers.includes(responder)) {
    exit(`User '${responder}' is not a target user for survey '${surveyId}'`);
  }

  // ---- Step 5: Validate answers against questions ----
  const validatedAnswers: Record<string, string | string[]> = {};
  for (const question of survey.questions) {
    const answer = answers[question.id];
    if (answer === undefined || answer === null) {
      exit(`Missing answer for question '${question.id}'`);
    }
    try {
      validatedAnswers[question.id] = validateAnswer(question, answer);
    } catch (err) {
      exit(err instanceof ValidationError ? err.message : String(err));
    }
  }

  // ---- Step 6: Record response under lock ----
  const lockPath = `${surveyFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Re-read under lock for consistency
    const content = await readFile(surveyFile, 'utf-8');
    const currentSurvey = parseSurveyFile(content, surveyFile);

    // Re-check status (could have changed)
    if (currentSurvey.status !== 'active') {
      throw new ValidationError(`Survey '${surveyId}' is no longer active`);
    }

    // Build response
    const response: SurveyResponse = {
      responder: survey!.anonymous ? 'anonymous' : responder!,
      respondedAt: nowISO(),
      answers: validatedAnswers,
    };

    // Store response (keyed by responder to allow updates)
    const responseKey = survey!.anonymous
      ? `anon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      : responder!;
    currentSurvey.responses[responseKey] = response;

    // Atomic write
    const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(currentSurvey, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, surveyFile);
  });

  const responseCount = Object.keys(
    (await readFile(surveyFile, 'utf-8').then((c) => JSON.parse(c)) as SurveyFile).responses,
  ).length;
  console.log(
    `OK: Response recorded for survey ${surveyId} (${responseCount}/${survey.targetUsers.length} responses)`,
  );
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
