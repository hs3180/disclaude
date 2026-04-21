#!/usr/bin/env tsx
/**
 * survey/create.ts — Create a new survey file.
 *
 * Environment variables:
 *   SURVEY_ID           (required) Unique survey identifier
 *   SURVEY_TITLE        (required) Survey title
 *   SURVEY_DESCRIPTION  (optional) Survey description
 *   SURVEY_EXPIRES_AT   (required) ISO 8601 Z-suffix expiry timestamp
 *   SURVEY_ANONYMOUS    (optional) 'true' or 'false' (default: 'false')
 *   SURVEY_QUESTIONS    (required) JSON array of questions
 *   SURVEY_TARGET_USERS (required) JSON array of target user open IDs
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
import { withExclusiveLock } from '../chat/lock.js';

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

  // ---- Step 2: Validate title ----
  const title = process.env.SURVEY_TITLE;
  try {
    validateTitle(title ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 3: Validate optional description ----
  const description = process.env.SURVEY_DESCRIPTION;
  if (description) {
    try {
      validateDescription(description);
    } catch (err) {
      exit(err instanceof ValidationError ? err.message : String(err));
    }
  }

  // ---- Step 4: Validate expiresAt ----
  const expiresAt = process.env.SURVEY_EXPIRES_AT;
  try {
    validateExpiresAt(expiresAt ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 5: Validate anonymous flag ----
  const anonymousRaw = process.env.SURVEY_ANONYMOUS ?? 'false';
  if (anonymousRaw !== 'true' && anonymousRaw !== 'false') {
    exit(`SURVEY_ANONYMOUS must be 'true' or 'false', got '${anonymousRaw}'`);
  }
  const anonymous = anonymousRaw === 'true';

  // ---- Step 6: Validate questions ----
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

  // ---- Step 7: Validate target users ----
  const usersRaw = process.env.SURVEY_TARGET_USERS;
  let targetUsers;
  try {
    const parsed = usersRaw ? JSON.parse(usersRaw) : undefined;
    targetUsers = validateTargetUsers(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`SURVEY_TARGET_USERS must be valid JSON: ${usersRaw}`);
  }

  // ---- Step 8: Setup directory and resolve path ----
  const surveyDir = resolve(SURVEY_DIR);
  await mkdir(surveyDir, { recursive: true });

  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  // ---- Step 9: Check uniqueness under lock ----
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

    // ---- Step 10: Write survey file ----
    const surveyData: SurveyFile = {
      id: surveyId!,
      status: 'active',
      title: title!,
      ...(description ? { description } : {}),
      createdAt: nowISO(),
      expiresAt: expiresAt!,
      anonymous,
      questions,
      targetUsers,
      responses: [],
      closedAt: null,
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
