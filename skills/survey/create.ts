#!/usr/bin/env tsx
/**
 * survey/create.ts — Create a new survey file.
 *
 * Environment variables:
 *   SURVEY_ID            (required) Unique survey identifier (e.g. "survey-restaurant-001")
 *   SURVEY_TITLE         (required) Survey title
 *   SURVEY_DESCRIPTION   (required) Survey description
 *   SURVEY_DEADLINE      (required) ISO 8601 Z-suffix deadline timestamp
 *   SURVEY_TARGET_USERS  (required) JSON array of target user open IDs
 *   SURVEY_QUESTIONS     (required) JSON array of question objects
 *   SURVEY_ANONYMOUS     (optional) "true" or "false" (default: "false")
 *   SURVEY_CREATED_BY    (required) Creator's open ID
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { mkdir, writeFile, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  validateTitle,
  validateDescription,
  validateDeadline,
  validateTargetUsers,
  validateQuestions,
  validateCreatedBy,
  nowISO,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
} from './schema.js';
import { withExclusiveLock } from './lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Step 1: Validate survey ID ----
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Validate required fields ----
  const title = process.env.SURVEY_TITLE;
  try {
    validateTitle(title ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const description = process.env.SURVEY_DESCRIPTION;
  try {
    validateDescription(description ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const deadline = process.env.SURVEY_DEADLINE;
  try {
    validateDeadline(deadline ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const targetUsersRaw = process.env.SURVEY_TARGET_USERS;
  let targetUsers: string[];
  try {
    const parsed = targetUsersRaw ? JSON.parse(targetUsersRaw) : undefined;
    targetUsers = validateTargetUsers(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`SURVEY_TARGET_USERS must be valid JSON: ${targetUsersRaw}`);
  }

  const questionsRaw = process.env.SURVEY_QUESTIONS;
  let questions;
  try {
    const parsed = questionsRaw ? JSON.parse(questionsRaw) : undefined;
    questions = validateQuestions(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`SURVEY_QUESTIONS must be valid JSON: ${questionsRaw}`);
  }

  const createdBy = process.env.SURVEY_CREATED_BY;
  try {
    validateCreatedBy(createdBy ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const anonymous = process.env.SURVEY_ANONYMOUS === 'true';

  // ---- Step 3: Setup directory and resolve path ----
  const surveyDir = resolve(SURVEY_DIR);
  await mkdir(surveyDir, { recursive: true });

  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  // ---- Step 4: Check uniqueness under lock ----
  const lockPath = `${surveyFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Double-check file doesn't exist
    try {
      await stat(surveyFile);
      throw new ValidationError(`Survey ${surveyId} already exists`);
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw err;
      const nodeErr = err as { code?: string };
      if (nodeErr.code !== 'ENOENT') {
        throw new Error(`Failed to check survey file: ${err}`);
      }
    }

    // ---- Step 5: Write survey file ----
    const surveyData: SurveyFile = {
      id: surveyId!,
      title: title!,
      description: description!,
      status: 'open',
      anonymous,
      deadline: deadline!,
      targetUsers,
      questions,
      responses: {},
      createdAt: nowISO(),
      createdBy: createdBy!,
    };

    // Atomic write: write to temp file then rename
    const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(surveyData, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, surveyFile);
  });

  console.log(`OK: Survey ${surveyId} created successfully`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
