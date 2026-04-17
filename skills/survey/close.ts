#!/usr/bin/env tsx
/**
 * survey/close.ts — Close an active survey.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 *
 * @module skills/survey/close
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  nowISO,
  SURVEY_DIR,
  ValidationError,
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

  const surveyFile = resolve(SURVEY_DIR, `${surveyId}.json`);
  const lockPath = `${surveyFile}.lock`;

  await withExclusiveLock(lockPath, async () => {
    let json: string;
    try {
      json = await readFile(surveyFile, 'utf-8');
    } catch (err: unknown) {
      const nodeErr = err as { code?: string };
      if (nodeErr.code === 'ENOENT') {
        throw new ValidationError(`Survey ${surveyId} not found`);
      }
      throw new Error(`Failed to read survey file: ${err}`);
    }

    const survey = parseSurveyFile(json, surveyFile);

    if (survey.status === 'closed') {
      throw new ValidationError(`Survey ${surveyId} is already closed`);
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
