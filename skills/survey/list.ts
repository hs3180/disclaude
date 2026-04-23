#!/usr/bin/env tsx
/**
 * survey/list.ts — List all surveys with optional status filter.
 *
 * Environment variables:
 *   SURVEY_STATUS  (optional) Filter by status: open, closed, expired
 *
 * Output: JSON array of survey summaries
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseSurveyFile, isExpired, SURVEY_DIR } from './schema.js';

async function main() {
  const dir = resolve(SURVEY_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    // Directory doesn't exist yet — no surveys
    console.log(JSON.stringify([]));
    return;
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.includes('.tmp.') && !f.includes('.lock'));
  const filterStatus = process.env.SURVEY_STATUS;
  const surveys: unknown[] = [];

  for (const file of jsonFiles) {
    try {
      const content = await readFile(resolve(dir, file), 'utf-8');
      const survey = parseSurveyFile(content, resolve(dir, file));

      // Auto-expire check
      if (survey.status === 'open' && isExpired(survey.deadline)) {
        survey.status = 'expired';
      }

      // Apply filter
      if (filterStatus && survey.status !== filterStatus) {
        continue;
      }

      // Count unique responders
      const uniqueResponders = new Set<string>();
      for (const resp of Object.values(survey.responses)) {
        uniqueResponders.add(resp.responder);
      }

      surveys.push({
        id: survey.id,
        title: survey.title,
        status: survey.status,
        questionCount: survey.questions.length,
        targetCount: survey.targets.length,
        responderCount: uniqueResponders.size,
        deadline: survey.deadline,
        createdAt: survey.createdAt,
        anonymous: survey.anonymous,
      });
    } catch {
      // Skip invalid files silently
    }
  }

  // Sort by creation date descending
  surveys.sort((a, b) => {
    const aTime = new Date((a as { createdAt: string }).createdAt).getTime();
    const bTime = new Date((b as { createdAt: string }).createdAt).getTime();
    return bTime - aTime;
  });

  console.log(JSON.stringify(surveys, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
