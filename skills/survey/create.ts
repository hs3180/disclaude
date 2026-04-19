#!/usr/bin/env tsx
/**
 * survey/create.ts — Create a new survey file.
 *
 * Environment variables:
 *   SURVEY_ID            (required) Unique survey identifier (e.g. "lunch-2026-04-19")
 *   SURVEY_TITLE         (required) Survey title
 *   SURVEY_DESCRIPTION   (optional) Survey description
 *   SURVEY_EXPIRES_AT    (required) ISO 8601 Z-suffix expiry timestamp
 *   SURVEY_TARGET_USERS  (required) JSON array of target user open IDs
 *   SURVEY_QUESTIONS     (required) JSON array of question objects
 *   SURVEY_ANONYMOUS     (optional) 'true' for anonymous survey (default: 'false')
 *   SURVEY_CHAT_ID       (required) Chat ID where the survey is initiated
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
  validateExpiresAt,
  validateTargetUsers,
  validateQuestions,
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
    validateDescription(description);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const expiresAt = process.env.SURVEY_EXPIRES_AT;
  try {
    validateExpiresAt(expiresAt ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const chatId = process.env.SURVEY_CHAT_ID;
  if (!chatId) {
    exit('SURVEY_CHAT_ID is required');
  }

  // ---- Step 3: Parse and validate complex fields ----
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

  const anonymous = process.env.SURVEY_ANONYMOUS === 'true';

  // ---- Step 4: Setup directory and resolve path ----
  const surveyDir = resolve(SURVEY_DIR);
  await mkdir(surveyDir, { recursive: true });

  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  // ---- Step 5: Check uniqueness under lock ----
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

    // ---- Step 6: Write survey file ----
    const surveyData: SurveyFile = {
      id: surveyId!,
      title: title!,
      ...(description ? { description } : {}),
      status: 'open',
      anonymous,
      expiresAt: expiresAt!,
      createdAt: nowISO(),
      targetUsers,
      questions,
      responses: {},
      chatId,
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
