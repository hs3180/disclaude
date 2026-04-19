#!/usr/bin/env tsx
/**
 * survey/query.ts — Query a survey's status and results.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier to query
 *
 * Output: Raw JSON survey file content
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  SURVEY_DIR,
  ValidationError,
} from './schema.js';

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

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  let json: string;
  try {
    json = await readFile(surveyFile, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey '${surveyId}' not found`);
    }
    throw err;
  }

  // Validate file structure
  parseSurveyFile(json, surveyFile);

  // Output raw JSON
  console.log(json);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
