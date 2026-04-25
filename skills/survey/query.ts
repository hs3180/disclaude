#!/usr/bin/env tsx
/**
 * survey/query.ts — Query a survey's current status and details.
 *
 * Environment variables:
 *   SURVEY_ID (required) Unique survey identifier
 *
 * Exit codes:
 *   0 — success (survey content printed to stdout)
 *   1 — validation error or survey not found
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  SURVEY_DIR,
  ValidationError,
} from './schema.js';
import { withSharedLock } from './lock.js';

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

  // Read under shared lock
  const lockPath = `${surveyFile}.lock`;
  await withSharedLock(lockPath, async () => {
    const content = await readFile(surveyFile, 'utf-8');
    parseSurveyFile(content, surveyFile); // Validate before output
    process.stdout.write(content);
  });
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
