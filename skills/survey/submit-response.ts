#!/usr/bin/env tsx
/**
 * survey/submit-response.ts — Submit a user's response to a survey.
 *
 * Records a user's answers in the survey file. Supports partial responses
 * (user can submit answers for a subset of questions).
 * Idempotent: if user already responded, their response is updated.
 *
 * Environment variables:
 *   SURVEY_ID      (required) Survey identifier
 *   SURVEY_USER_ID (required) User's open ID (e.g. "ou_xxxxx")
 *   SURVEY_ANSWERS (required) JSON object mapping question IDs to answers
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { readFile, writeFile, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  validateUserId,
  validateAnswers,
  parseSurveyFile,
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

  const userId = process.env.SURVEY_USER_ID;
  try {
    validateUserId(userId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Validate answers ----
  const answersRaw = process.env.SURVEY_ANSWERS;

  // ---- Step 3: Read survey file ----
  const surveyDir = resolve(SURVEY_DIR);
  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  // Check file exists
  try {
    await stat(surveyFile);
  } catch (err: unknown) {
    // @ts-expect-error - checking error code
    if (err?.code === 'ENOENT') {
      exit(`Survey ${surveyId} not found`);
    }
    exit(`Failed to access survey file: ${err}`);
  }

  // ---- Step 4: Update under exclusive lock ----
  const lockPath = `${surveyFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    const content = await readFile(surveyFile, 'utf-8');
    const survey: SurveyFile = parseSurveyFile(content, surveyFile);

    // Check survey status
    if (survey.status !== 'active') {
      throw new ValidationError(`Survey ${surveyId} is '${survey.status}', cannot accept responses`);
    }

    // Check if user is a target
    if (!survey.targetUsers.includes(userId!)) {
      throw new ValidationError(
        `User '${userId}' is not a target user for survey '${surveyId}'`,
      );
    }

    // Validate answers against survey questions
    let answers: Record<string, string | string[]>;
    try {
      const parsed = answersRaw ? JSON.parse(answersRaw) : undefined;
      answers = validateAnswers(parsed, survey.questions);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`SURVEY_ANSWERS must be valid JSON: ${answersRaw}`);
    }

    // ---- Step 5: Write updated survey file ----
    const updatedSurvey: SurveyFile = {
      ...survey,
      responses: {
        ...survey.responses,
        [userId!]: {
          respondedAt: nowISO(),
          answers,
        },
      },
    };

    // Atomic write
    const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(updatedSurvey, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, surveyFile);
  });

  console.log(`OK: Response recorded for user ${userId} in survey ${surveyId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
