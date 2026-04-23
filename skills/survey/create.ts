#!/usr/bin/env tsx
/**
 * survey/create.ts — Create a new survey file.
 *
 * Environment variables:
 *   SURVEY_ID          (required) Unique survey identifier
 *   SURVEY_TITLE       (required) Survey title
 *   SURVEY_DESCRIPTION (optional) Survey description (default: '')
 *   SURVEY_ANONYMOUS   (optional) 'true' for anonymous (default: 'false')
 *   SURVEY_TARGETS     (required) JSON array of target open IDs
 *   SURVEY_QUESTIONS   (required) JSON array of question objects [{text, options}]
 *   SURVEY_DEADLINE    (required) ISO 8601 Z-suffix deadline
 *   SURVEY_CHAT_ID     (optional) Chat ID where survey is sent
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  validateTitle,
  validateDescription,
  validateTargets,
  validateQuestions,
  validateDeadline,
  parseSurveyFile,
  ValidationError,
  type SurveyFile,
  SURVEY_DIR,
  nowISO,
} from './schema.js';
import { withExclusiveLock } from '../chat/lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Validate survey ID ----
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Validate title ----
  const title = process.env.SURVEY_TITLE;
  try {
    validateTitle(title ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Validate description ----
  const description = process.env.SURVEY_DESCRIPTION ?? '';
  try {
    validateDescription(description);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Validate anonymous flag ----
  const anonymousRaw = process.env.SURVEY_ANONYMOUS?.toLowerCase();
  const anonymous = anonymousRaw === 'true';

  // ---- Validate targets ----
  let targets: string[];
  try {
    const parsed = process.env.SURVEY_TARGETS ? JSON.parse(process.env.SURVEY_TARGETS) : undefined;
    targets = validateTargets(parsed);
  } catch (err) {
    if (err instanceof ValidationError) exit(err.message);
    exit(`SURVEY_TARGETS must be valid JSON: ${process.env.SURVEY_TARGETS}`);
  }

  // ---- Validate questions ----
  let questions;
  try {
    const parsed = process.env.SURVEY_QUESTIONS ? JSON.parse(process.env.SURVEY_QUESTIONS) : undefined;
    questions = validateQuestions(parsed);
  } catch (err) {
    if (err instanceof ValidationError) exit(err.message);
    exit(`SURVEY_QUESTIONS must be valid JSON: ${process.env.SURVEY_QUESTIONS}`);
  }

  // ---- Validate deadline ----
  const deadline = process.env.SURVEY_DEADLINE;
  try {
    validateDeadline(deadline ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Optional chat ID ----
  const chatId = process.env.SURVEY_CHAT_ID ?? null;

  // ---- Setup directory and create file ----
  const dir = resolve(SURVEY_DIR);
  await mkdir(dir, { recursive: true });

  const filePath = resolve(dir, `${surveyId}.json`);

  // Build survey object
  const survey: SurveyFile = {
    id: surveyId!,
    status: 'open',
    title: title!,
    description,
    anonymous,
    targets,
    questions,
    deadline: deadline!,
    createdAt: nowISO(),
    chatId,
    responses: {},
  };

  // Write atomically under exclusive lock to prevent TOCTOU races
  await withExclusiveLock(`${filePath}.lock`, async () => {
    // Check uniqueness
    try {
      const { readFile } = await import('node:fs/promises');
      const existing = await readFile(filePath, 'utf-8');
      parseSurveyFile(existing, filePath); // Validate existing file
      exit(`Survey '${surveyId}' already exists`);
    } catch (err: unknown) {
      const nodeErr = err as { code?: string };
      if (nodeErr.code !== 'ENOENT') {
        throw err;
      }
      // File doesn't exist — proceed
    }

    // Write atomically via temp file + rename
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    await writeFile(tmpPath, JSON.stringify(survey, null, 2), 'utf-8');
    await rename(tmpPath, filePath);
  });

  // Output survey info for the agent
  console.log(JSON.stringify({
    success: true,
    message: `Survey '${surveyId}' created successfully`,
    survey: {
      id: survey.id,
      title: survey.title,
      questions: survey.questions.length,
      targets: survey.targets.length,
      deadline: survey.deadline,
      anonymous: survey.anonymous,
    },
  }));
}

main().catch((err) => {
  exit(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
