#!/usr/bin/env tsx
/**
 * survey/close.ts — Close a survey (set status to 'closed').
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
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
  nowISO,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
} from './schema.js';

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

  // ---- Step 2: Read survey file ----
  const surveyFile = resolve(SURVEY_DIR, `${surveyId}.json`);
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

  // ---- Step 3: Check status ----
  if (survey.status === 'closed') {
    exit(`Survey '${surveyId}' is already closed`);
  }

  // ---- Step 4: Close survey ----
  survey.status = 'closed';
  survey.closedAt = nowISO();

  // Atomic write
  const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(survey, null, 2) + '\n', 'utf-8');
  await rename(tmpFile, surveyFile);

  const totalResponses = Object.keys(survey.responses).length;
  console.log(`OK: Survey '${surveyId}' closed (${totalResponses} responses collected)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
