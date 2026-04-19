#!/usr/bin/env tsx
/**
 * survey/respond.ts — Record a user's response to a survey.
 *
 * Environment variables:
 *   SURVEY_ID           (required) Survey identifier
 *   SURVEY_RESPONDER    (required) Responder's open ID (e.g. "ou_xxx")
 *   SURVEY_ANSWERS      (required) JSON object of question-id → answer value
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
  MAX_ANSWER_LENGTH,
  ValidationError,
  type SurveyFile,
  type SurveyResponse,
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

  const responder = process.env.SURVEY_RESPONDER;
  if (!responder) {
    exit('SURVEY_RESPONDER is required');
  }

  const answersRaw = process.env.SURVEY_ANSWERS;
  let answers: Record<string, string>;
  try {
    answers = answersRaw ? JSON.parse(answersRaw) : undefined;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new Error('must be a JSON object');
    }
  } catch {
    exit(`SURVEY_ANSWERS must be a valid JSON object: ${answersRaw}`);
  }

  // Validate answer lengths
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value !== 'string') {
      exit(`Answer for '${key}' must be a string`);
    }
    if (value.length > MAX_ANSWER_LENGTH) {
      exit(`Answer for '${key}' too long (${value.length} chars, max ${MAX_ANSWER_LENGTH})`);
    }
  }

  // ---- Step 2: Read and validate survey file ----
  const surveyDir = resolve(SURVEY_DIR);
  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  const lockPath = `${surveyFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    let json: string;
    try {
      json = await readFile(surveyFile, 'utf-8');
    } catch (err: unknown) {
      const nodeErr = err as { code?: string };
      if (nodeErr.code === 'ENOENT') {
        throw new ValidationError(`Survey '${surveyId}' not found`);
      }
      throw err;
    }

    const survey: SurveyFile = parseSurveyFile(json, surveyFile);

    // ---- Step 3: Validate survey state ----
    if (survey.status === 'closed') {
      throw new ValidationError(`Survey '${surveyId}' is closed and no longer accepting responses`);
    }

    const now = new Date();
    const expiry = new Date(survey.expiresAt);
    if (expiry <= now) {
      // Auto-close expired survey
      survey.status = 'closed';
      const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
      await writeFile(tmpFile, JSON.stringify(survey, null, 2) + '\n', 'utf-8');
      await rename(tmpFile, surveyFile);
      throw new ValidationError(`Survey '${surveyId}' has expired and is now closed`);
    }

    // ---- Step 4: Record response ----
    // Check if this question-answer mapping is valid
    const validQuestionIds = new Set(survey.questions.map((q) => q.id));
    for (const key of Object.keys(answers)) {
      if (!validQuestionIds.has(key)) {
        throw new ValidationError(`Unknown question ID '${key}' in answers`);
      }
    }

    const responseKey = survey.anonymous
      ? `anon_${Object.keys(survey.responses).length + 1}`
      : responder;

    // Prevent duplicate responses (unless anonymous)
    if (!survey.anonymous && survey.responses[responder]) {
      throw new ValidationError(`User '${responder}' has already responded to survey '${surveyId}'`);
    }

    survey.responses[responseKey] = {
      responder: survey.anonymous ? 'anonymous' : responder,
      answeredAt: nowISO(),
      answers,
    } satisfies SurveyResponse;

    // ---- Step 5: Write updated survey ----
    const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(survey, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, surveyFile);
  });

  console.log(`OK: Response recorded for survey ${surveyId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
