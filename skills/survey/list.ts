#!/usr/bin/env tsx
/**
 * survey/list.ts — List all surveys, optionally filtered by status.
 *
 * Environment variables:
 *   SURVEY_STATUS  (optional) Filter by status: 'open' or 'closed'
 *
 * Output: JSON array of survey summaries
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  parseSurveyFile,
  SURVEY_DIR,
  type SurveyFile,
  type SurveyStatus,
} from './schema.js';

interface SurveySummary {
  id: string;
  title: string;
  status: SurveyStatus;
  createdAt: string;
  expiresAt: string;
  targetCount: number;
  responseCount: number;
}

async function main() {
  const statusFilter = process.env.SURVEY_STATUS;

  if (statusFilter && statusFilter !== 'open' && statusFilter !== 'closed') {
    console.error(`ERROR: SURVEY_STATUS must be 'open' or 'closed', got '${statusFilter}'`);
    process.exit(1);
  }

  const surveyDir = resolve(SURVEY_DIR);

  let entries: string[];
  try {
    entries = await readdir(surveyDir);
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      // No surveys directory yet — output empty array
      console.log('[]');
      return;
    }
    throw err;
  }

  const summaries: SurveySummary[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;

    const filePath = join(surveyDir, entry);
    try {
      const json = await readFile(filePath, 'utf-8');
      const survey: SurveyFile = parseSurveyFile(json, filePath);

      if (statusFilter && survey.status !== statusFilter) continue;

      summaries.push({
        id: survey.id,
        title: survey.title,
        status: survey.status,
        createdAt: survey.createdAt,
        expiresAt: survey.expiresAt,
        targetCount: survey.targetUsers.length,
        responseCount: Object.keys(survey.responses).length,
      });
    } catch {
      // Skip invalid survey files
    }
  }

  // Sort by creation date descending (newest first)
  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  console.log(JSON.stringify(summaries, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
