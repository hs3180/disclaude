#!/usr/bin/env tsx
/**
 * survey/respond.ts — Record a response to a survey.
 *
 * Environment variables:
 *   SURVEY_ID         (required) Survey identifier
 *   SURVEY_RESPONDER  (required) Responder's open ID
 *   SURVEY_ANSWERS    (required) JSON object of answers keyed by question index
 *                              e.g. '{"0": "Option A", "1": "Good"}'
 *                              For multiple_choice: '{"0": ["A", "B"]}'
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  nowISO,
  SURVEY_DIR,
  ValidationError,
  MAX_ANSWER_LENGTH,
} from './schema.js';
import { withExclusiveLock } from './lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
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
  if (!responder) {
    exit('SURVEY_RESPONDER environment variable is required');
  }

  // ---- Step 3: Validate answers ----
  const answersRaw = process.env.SURVEY_ANSWERS;
  let answers: Record<string, string | string[]>;
  try {
    answers = answersRaw ? JSON.parse(answersRaw) : undefined;
  } catch {
    exit(`SURVEY_ANSWERS must be valid JSON: ${answersRaw}`);
  }

  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    exit('SURVEY_ANSWERS must be a JSON object');
  }

  // Validate answer values
  for (const [key, value] of Object.entries(answers)) {
    const qIdx = parseInt(key, 10);
    if (isNaN(qIdx) || qIdx < 0) {
      exit(`Invalid question index in answers: '${key}'`);
    }
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v !== 'string' || v.length > MAX_ANSWER_LENGTH) {
          exit(`Answer for question ${key} contains invalid or too-long value`);
        }
      }
    } else if (typeof value === 'string') {
      if (value.length > MAX_ANSWER_LENGTH) {
        exit(`Answer for question ${key} too long (${value.length} chars, max ${MAX_ANSWER_LENGTH})`);
      }
    } else {
      exit(`Answer for question ${key} must be a string or array of strings`);
    }
  }

  // ---- Step 4: Read and validate survey file ----
  const surveyDir = resolve(SURVEY_DIR);
  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  let rawJson: string;
  try {
    rawJson = await readFile(surveyFile, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey ${surveyId} not found`);
    }
    throw err;
  }

  const survey = parseSurveyFile(rawJson, surveyFile);

  // ---- Step 5: Check survey status ----
  if (survey.status !== 'open') {
    exit(`Survey ${surveyId} is ${survey.status} (cannot accept responses)`);
  }

  // Check deadline
  if (new Date(survey.deadline) <= new Date()) {
    exit(`Survey ${surveyId} has expired (deadline: ${survey.deadline})`);
  }

  // Validate answers against questions
  for (const [key] of Object.entries(answers)) {
    const qIdx = parseInt(key, 10);
    if (qIdx >= survey.questions.length) {
      exit(`Question index ${qIdx} out of range (survey has ${survey.questions.length} questions)`);
    }
  }

  // ---- Step 6: Record response under lock ----
  const lockPath = `${surveyFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Re-read under lock to get latest state
    const freshJson = await readFile(surveyFile, 'utf-8');
    const freshSurvey = parseSurveyFile(freshJson, surveyFile);

    if (freshSurvey.status !== 'open') {
      throw new ValidationError(`Survey ${surveyId} is now ${freshSurvey.status}`);
    }

    // Check for duplicate response (unless anonymous)
    const effectiveResponder = freshSurvey.anonymous ? 'anonymous' : responder;
    if (!freshSurvey.anonymous) {
      const existing = freshSurvey.responses.find((r) => r.responder === responder);
      if (existing) {
        throw new ValidationError(`Responder ${responder} has already responded to survey ${surveyId}`);
      }
    }

    // Add response
    freshSurvey.responses.push({
      responder: effectiveResponder,
      respondedAt: nowISO(),
      answers,
    });

    // Atomic write
    const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(freshSurvey, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, surveyFile);
  });

  console.log(`OK: Response recorded for survey ${surveyId}`);
  console.log(`  Responder: ${survey.anonymous ? '(anonymous)' : responder}`);
  console.log(`  Total responses: (updated)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
