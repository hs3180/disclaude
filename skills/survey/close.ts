#!/usr/bin/env tsx
/**
 * survey/close.ts — Close an open survey.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier to close
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
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const surveyDir = resolve(SURVEY_DIR);
  const filePath = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!filePath.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey '${surveyId}' not found`);
    }
    throw err;
  }

  let survey: SurveyFile;
  try {
    survey = parseSurveyFile(content, filePath);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  if (survey.status === 'closed') {
    exit(`Survey '${surveyId}' is already closed`);
  }

  // Update survey
  survey.status = 'closed';
  survey.closedAt = nowISO();

  // Atomic write
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(survey, null, 2) + '\n', 'utf-8');
  await rename(tmpFile, filePath);

  const totalResponses = Object.keys(survey.responses).length;
  console.log(`OK: Survey '${surveyId}' closed`);
  console.log(`Total responses: ${totalResponses} / ${survey.targetUsers.length}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
