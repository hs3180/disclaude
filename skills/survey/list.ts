#!/usr/bin/env tsx
/**
 * survey/list.ts — List surveys with optional status filter.
 *
 * Environment variables:
 *   SURVEY_STATUS (optional) Filter by status: "draft", "active", "closed"
 *
 * Exit codes:
 *   0 — success
 *   1 — directory not found
 */

import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  parseSurveyFile,
  SURVEY_DIR,
  type SurveyStatus,
} from './schema.js';
import { acquireLock } from '../chat/lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const filter = process.env.SURVEY_STATUS as SurveyStatus | undefined;

  // Validate filter if provided
  if (filter && !['draft', 'active', 'closed'].includes(filter)) {
    exit(`Invalid SURVEY_STATUS '${filter}' — must be one of: draft, active, closed`);
  }

  // Validate survey directory
  let surveyDir: string;
  try {
    const resolved = resolve(SURVEY_DIR);
    await stat(resolved);
    surveyDir = await realpath(resolved);
  } catch {
    exit('workspace/surveys directory not found');
  }

  // List survey files
  let files: string[];
  try {
    files = await readdir(surveyDir);
  } catch {
    exit('Failed to read survey directory');
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    const filePath = resolve(surveyDir, fileName);

    // Verify file is still within survey directory after symlink resolution
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch {
      continue; // Skip broken symlinks
    }

    if (dirname(realFilePath) !== surveyDir) {
      console.error(`WARN: Skipping file outside survey directory: ${filePath}`);
      continue;
    }

    // Read and validate file
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    let survey;
    try {
      survey = parseSurveyFile(content, filePath);
    } catch {
      console.error(`WARN: Skipping corrupted file: ${filePath}`);
      continue;
    }

    // Acquire shared lock for consistent read (skip if unavailable)
    const lock = await acquireLock(`${filePath}.lock`, 'shared', 0);
    try {
      // Re-read under lock for consistency
      content = await readFile(filePath, 'utf-8');
      survey = parseSurveyFile(content, filePath);

      // Apply filter
      if (!filter || survey.status === filter) {
        const responseCount = Object.keys(survey.responses).length;
        console.log(
          `${survey.id} | ${survey.status} | ${survey.title} | ${responseCount}/${survey.targetUsers.length} responses`,
        );
      }
    } catch {
      // Skip if we can't read under lock
    } finally {
      await lock.release();
    }
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
