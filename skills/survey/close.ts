#!/usr/bin/env tsx
/**
 * survey/close.ts — Close an active survey, transitioning it to 'closed' status.
 *
 * Environment variables:
 *   SURVEY_ID (required) Survey identifier
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
import { withExclusiveLock } from '../chat/lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const surveyDir = resolve(SURVEY_DIR);
  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  await withExclusiveLock(`${surveyFile}.lock`, async () => {
    let survey: SurveyFile;
    try {
      const content = await readFile(surveyFile, 'utf-8');
      survey = parseSurveyFile(content, surveyFile);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new Error(`Survey '${surveyId}' not found`);
    }

    if (survey.status !== 'active') {
      throw new ValidationError(
        `Survey '${surveyId}' cannot be closed (current status: ${survey.status}, expected: active)`,
      );
    }

    survey.status = 'closed';
    survey.closedAt = nowISO();

    // Atomic write
    const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(survey, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, surveyFile);
  });

  console.log(`OK: Survey ${surveyId} closed`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
