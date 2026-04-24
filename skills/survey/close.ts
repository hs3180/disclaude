#!/usr/bin/env tsx
/**
 * survey/close.ts — Close a survey (set status to 'closed').
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
 *
 * Exit codes:
 *   0 — success
 *   1 — error
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  SURVEY_DIR,
  ValidationError,
} from './schema.js';
import { withExclusiveLock } from './lock.js';

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

  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  const lockPath = `${surveyFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    let data: string;
    try {
      data = await readFile(surveyFile, 'utf-8');
    } catch (err: unknown) {
      const nodeErr = err as { code?: string };
      if (nodeErr.code === 'ENOENT') {
        exit(`Survey ${surveyId} not found`);
      }
      throw err;
    }

    const survey = parseSurveyFile(data, surveyFile);

    if (survey.status === 'closed') {
      exit(`Survey ${surveyId} is already closed`);
    }

    survey.status = 'closed';

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
