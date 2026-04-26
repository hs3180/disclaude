#!/usr/bin/env tsx
/**
 * survey/create.ts — Create a new survey file.
 *
 * Environment variables:
 *   SURVEY_ID          (required) Unique survey identifier
 *   SURVEY_TITLE       (required) Survey title
 *   SURVEY_DESCRIPTION (optional) Survey description (default: '')
 *   SURVEY_EXPIRES_AT  (required) ISO 8601 Z-suffix expiry timestamp
 *   SURVEY_ANONYMOUS   (optional) "true" for anonymous mode (default: "false")
 *   SURVEY_TARGET_USERS (required) JSON array of target user open IDs
 *   SURVEY_CHAT_ID     (required) The chat ID where the survey is created
 *   SURVEY_QUESTIONS   (required) JSON array of question objects
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
  validateQuestions,
  validateTargetUsers,
  validateExpiresAt,
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

  // ---- Step 3: Validate description ----
  const description = process.env.SURVEY_DESCRIPTION ?? '';
  try {
    validateDescription(description);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 4: Validate expiresAt ----
  const expiresAt = process.env.SURVEY_EXPIRES_AT;
  try {
    validateExpiresAt(expiresAt ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 5: Validate anonymous ----
  const anonymousRaw = process.env.SURVEY_ANONYMOUS ?? 'false';
  const anonymous = anonymousRaw === 'true';

  // ---- Step 6: Validate targetUsers ----
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

  // ---- Step 7: Validate chatId ----
  const chatId = process.env.SURVEY_CHAT_ID;
  if (!chatId || typeof chatId !== 'string') {
    exit('SURVEY_CHAT_ID is required');
  }

  // ---- Step 8: Validate questions ----
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

  // ---- Step 9: Setup directory and resolve path ----
  const surveyDir = resolve(SURVEY_DIR);
  await mkdir(surveyDir, { recursive: true });

  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  // ---- Step 10: Check uniqueness under lock ----
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

    // ---- Step 11: Write survey file ----
    const surveyData: SurveyFile = {
      id: surveyId!,
      title: title!,
      description,
      status: 'draft',
      createdAt: nowISO(),
      activatedAt: null,
      closedAt: null,
      expiresAt: expiresAt!,
      anonymous,
      targetUsers,
      chatId,
      questions,
      responses: {},
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
