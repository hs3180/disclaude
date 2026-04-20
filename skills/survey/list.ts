#!/usr/bin/env tsx
/**
 * survey/list.ts — List all surveys with optional status filter.
 *
 * Environment variables:
 *   SURVEY_STATUS  (optional) Filter by status: 'open' or 'closed'
 *
 * Exit codes:
 *   0 — success
 *   1 — error
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseSurveyFile,
  SURVEY_DIR,
  type SurveyFile,
} from './schema.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const statusFilter = process.env.SURVEY_STATUS;

  if (statusFilter && statusFilter !== 'open' && statusFilter !== 'closed') {
    exit(`SURVEY_STATUS must be 'open' or 'closed', got '${statusFilter}'`);
  }

  const surveyDir = resolve(SURVEY_DIR);

  let files: string[];
  try {
    files = await readdir(surveyDir);
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      console.log('No surveys found.');
      return;
    }
    throw err;
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));

  if (jsonFiles.length === 0) {
    console.log('No surveys found.');
    return;
  }

  const surveys: SurveyFile[] = [];

  for (const file of jsonFiles) {
    try {
      const content = await readFile(resolve(surveyDir, file), 'utf-8');
      const survey = parseSurveyFile(content, resolve(surveyDir, file));
      if (!statusFilter || survey.status === statusFilter) {
        surveys.push(survey);
      }
    } catch {
      // Skip invalid files
    }
  }

  // Sort by createdAt descending
  surveys.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  console.log(`📂 Surveys${statusFilter ? ` (${statusFilter})` : ''}`);
  console.log('');
  console.log('| ID | Title | Status | Questions | Responses | Expires |');
  console.log('|----|-------|--------|-----------|-----------|---------|');

  for (const s of surveys) {
    const responseCount = Object.keys(s.responses).length;
    const status = s.status === 'open' ? '🟢' : '🔴';
    console.log(
      `| ${s.id} | ${s.title} | ${status} ${s.status} | ${s.questions.length} | ${responseCount}/${s.targetUsers.length} | ${s.expiresAt.slice(0, 10)} |`,
    );
  }

  console.log(`\nTotal: ${surveys.length} survey(s)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
