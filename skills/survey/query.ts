#!/usr/bin/env tsx
/**
 * survey/query.ts — Query a survey's status and details.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier to query
 *
 * Exit codes:
 *   0 — success
 *   1 — error
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
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

  // Output structured result
  const responseCount = Object.keys(survey.responses).length;
  const targetCount = survey.targetUsers.length;

  console.log(`📋 Survey: ${survey.id}`);
  console.log(`> **Title**: ${survey.title}`);
  console.log(`> **Description**: ${survey.description || '(none)'}`);
  console.log(`> **Status**: ${survey.status === 'open' ? '🟢 Open' : '🔴 Closed'}`);
  console.log(`> **Anonymous**: ${survey.anonymous ? 'Yes' : 'No'}`);
  console.log(`> **Created**: ${survey.createdAt}`);
  console.log(`> **Expires**: ${survey.expiresAt}`);
  if (survey.closedAt) {
    console.log(`> **Closed**: ${survey.closedAt}`);
  }
  console.log(`> **Creator**: ${survey.creator}`);
  console.log(`> **Target Users**: ${targetCount}`);
  console.log(`> **Responses**: ${responseCount} / ${targetCount}`);

  // List questions
  console.log(`\n📝 Questions:`);
  for (const q of survey.questions) {
    console.log(`  ${q.id}. [${q.type}] ${q.question} ${q.required ? '(required)' : '(optional)'}`);
    if (q.type === 'single_choice' && q.options) {
      for (const opt of q.options) {
        console.log(`     - ${opt}`);
      }
    }
  }

  // Output raw JSON for programmatic consumption
  console.log(`\n---RAW_JSON---`);
  console.log(JSON.stringify(survey, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
