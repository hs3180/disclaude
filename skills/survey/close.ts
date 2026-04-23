#!/usr/bin/env tsx
/**
 * survey/close.ts — Close a survey, preventing further responses.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
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
  ValidationError,
  SURVEY_DIR,
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

  const filePath = resolve(SURVEY_DIR, `${surveyId}.json`);

  await withExclusiveLock(`${filePath}.lock`, async () => {
    let surveyJson: string;
    try {
      surveyJson = await readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      const nodeErr = err as { code?: string };
      if (nodeErr.code === 'ENOENT') {
        exit(`Survey '${surveyId}' not found`);
      }
      throw err;
    }

    const survey = parseSurveyFile(surveyJson, filePath);

    if (survey.status !== 'open') {
      exit(`Survey '${surveyId}' is already ${survey.status}`);
    }

    survey.status = 'closed';

    const tmpPath = `${filePath}.tmp.${process.pid}`;
    await writeFile(tmpPath, JSON.stringify(survey, null, 2), 'utf-8');
    await rename(tmpPath, filePath);
  });

  console.log(JSON.stringify({
    success: true,
    message: `Survey '${surveyId}' closed successfully`,
  }));
}

main().catch((err) => {
  exit(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
